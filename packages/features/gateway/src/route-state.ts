import { createHash } from 'node:crypto';
import type { GatewayRouteState, GatewayRouteStatus, UpstreamRouteFailure } from '@wrenyard/providers/base';
import { resetInstant, type RouteFaultKind } from './route-failure.ts';

type Scope = 'provider' | 'pool' | 'route';

/** Phase of one fault scope: `open` while it blocks requests, `closed` otherwise. */
export type CircuitPhase = 'closed' | 'open';

export interface RouteStateChangedEvent {
  publicModel: string;
  provider: string;
  scope: Scope;
  quotaPoolId?: string;
  state: GatewayRouteState | 'available';
  /** The specific fault kind behind this state, when the scope is faulted. */
  faultKind?: RouteFaultKind;
  phase: CircuitPhase;
  until?: string;
  /** The earliest instant this scope admits requests again. */
  nextRetryAt?: string;
  status: number;
  reason: 'upstream_error' | 'cooldown' | 'success' | 'credential_changed';
}

/** The route health a caller reads: the legacy status plus the circuit detail. */
export interface RouteStatus extends GatewayRouteStatus {
  faultKind?: RouteFaultKind;
  phase: CircuitPhase;
}

/**
 * A captured view of every fault scope that applied when a call started. A
 * completion may only clear or overwrite the exact generations it observed, so
 * a stale in-flight success or failure cannot overwrite a newer fault.
 */
export interface RouteGuard {
  readonly generations: ReadonlyMap<string, number>;
}

/** The admission decision for one route, taken before any upstream call. */
export type Admission =
  | { kind: 'admit'; guard: RouteGuard }
  | { kind: 'blocked'; status: RouteStatus };

interface Block extends GatewayRouteStatus {
  publicModel: string;
  provider: string;
  scope: Scope;
  quotaPoolId?: string;
  status: number;
  faultKind: RouteFaultKind;
  phase: CircuitPhase;
  /** Monotonic generation of this scope's latest fault. */
  generation: number;
  /** Consecutive failures of this scope; drives the exponential cooldown. */
  failures: number;
  /** The upstream stated when the scope recovers: it is cleared then, not kept for backoff. */
  resets: boolean;
  /** Fingerprint of the credential an auth failure was observed with. */
  credential?: string;
  timer: ReturnType<typeof setTimeout>;
}

/** A failure the store may record: the legacy shape plus an optional fault kind. */
export type MarkableFailure = UpstreamRouteFailure & { faultKind?: RouteFaultKind };

/** The HTTP status a native fault is reported with, matching its classification. */
function nativeFailureStatus(failure: MarkableFailure): number {
  switch (failure.faultKind ?? failure.state) {
    case 'rate_limited': return 429;
    case 'quota_exhausted': return 402;
    case 'auth_failed': return 401;
    case 'access_denied': return 403;
    case 'model_unavailable': return 404;
    default: return 502;
  }
}

/** Base cooldown of a fresh fault; the delay doubles per consecutive failure. */
const ROUTE_COOLDOWN_BASE_MS = 60_000;
/** Hard cap of the exponential cooldown: one hour. */
const MAX_ROUTE_COOLDOWN_MS = 60 * 60_000;
/** Jitter added to a computed cooldown, as a fraction of the delay. */
const ROUTE_COOLDOWN_JITTER = 0.25;
/** Inactive generation tombstones retained beyond the keys that hold a block. */
const MAX_GENERATION_TOMBSTONES = 4_096;
const MAX_TIMER_MS = 2_147_483_647;

const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * In-memory route health of one Gateway process, and the single authority for
 * automatic routing. Reads never trigger provider work: credentials are observed
 * only where the Gateway already reads them.
 *
 * A fault scope blocks requests until its `until`: an upstream-stated reset, or
 * an exponential backoff. After that the next real request is the probe. A
 * success clears the scope; a failure blocks it again for twice as long. A
 * scope with an upstream reset is cleared when the reset passes. There is no
 * half-open phase and no probe lease: requests admitted together that fail
 * together count once, through the generation fence.
 *
 * Only an upstream answer whose meaning is explicit (quota exhausted or a rate
 * limit with a stated reset, quota exhausted without one, 401, 403, 404) may
 * open a scope. Every other outcome is reported in request statistics only.
 */
export class RouteStateStore {
  private readonly blocks = new Map<string, Block>();
  /** Latest generation per scope key; bounded tombstones so late completions stay rejectable. */
  private readonly generations = new Map<string, number>();
  /** Store-wide monotonic generation sequence; never reset or reused per key. */
  private sequence = 0;
  /**
   * Highest generation evicted from `generations`. A key without a tombstone reads
   * at least this value, so a guard captured before an evicted transition still
   * fails the `current > captured` stale-failure fence. After eviction this can
   * also reject older unrelated completions; that conservative tradeoff is
   * accepted so the map stays bounded.
   */
  private retiredFloor = 0;

  constructor(
    private readonly now: () => number,
    private readonly pools: (provider: string, model: string) => readonly string[],
    private readonly emit: (event: RouteStateChangedEvent) => void,
    private readonly random: () => number = Math.random,
  ) {}

  status(provider: string, model: string): RouteStatus | undefined {
    const applying = this.applying(provider, model);
    return applying.length === 0 ? undefined : this.project(applying);
  }

  /**
   * Capture the exact fault generations that apply before a call is sent. Every
   * applicable scope key is recorded, including a scope whose block was already
   * cleared, so a stale in-flight completion can never rebuild a cleared fault.
   */
  capture(provider: string, model: string): RouteGuard {
    const generations = new Map<string, number>();
    // A key without a tombstone is stamped with the current sequence, not zero, so
    // its guard stays meaningful after a tombstone eviction raises the floor.
    for (const key of this.applicableKeys(provider, model)) generations.set(key, this.generations.get(key) ?? this.sequence);
    return { generations };
  }

  /** Admit one call before any upstream traffic, unless a scope still blocks the route. */
  admit(provider: string, model: string): Admission {
    const applying = this.applying(provider, model);
    const guard = this.capture(provider, model);
    return applying.length === 0 ? { kind: 'admit', guard } : { kind: 'blocked', status: this.project(applying) };
  }

  /**
   * Record a route-local fault a native task attempt already classified for its
   * own route. The failure carries its own fault kind, scope and any
   * upstream-stated reset instant, so it is the same as a gateway-observed
   * fault, fenced by the guard captured when the attempt started.
   */
  reportNativeRouteFault(provider: string, model: string, failure: MarkableFailure, guard?: RouteGuard): RouteStatus | undefined {
    return this.mark(provider, model, failure, nativeFailureStatus(failure), '', guard);
  }

  /** Advance the store-wide sequence and record the key's new generation. */
  private advanceGeneration(key: string): number {
    const generation = ++this.sequence;
    // Re-insert so map order follows transition order and the oldest tombstone is
    // also the lowest generation.
    this.generations.delete(key);
    this.generations.set(key, generation);
    return generation;
  }

  /**
   * Bound the tombstones to {@link MAX_GENERATION_TOMBSTONES} beyond the keys that
   * hold a block. Active block generations are never evicted; the retired floor
   * rises to the highest evicted generation so a guard captured before that
   * transition still fails the stale-failure fence.
   */
  private pruneGenerations(): void {
    const limit = this.blocks.size + MAX_GENERATION_TOMBSTONES;
    // Only an over-allowance map is scanned, so normal marks and removals stay O(1).
    if (this.generations.size <= limit) return;
    for (const [key, generation] of this.generations) {
      if (this.generations.size <= limit) break;
      if (this.blocks.has(key)) continue;
      this.generations.delete(key);
      if (generation > this.retiredFloor) this.retiredFloor = generation;
    }
  }

  /**
   * The cooldown after `failures` consecutive failures of one scope: a 60s base
   * doubling per failure, clamped to one hour, plus up to 25% jitter.
   */
  private backoffMs(failures: number): number {
    const delay = Math.min(ROUTE_COOLDOWN_BASE_MS * 2 ** Math.max(0, failures - 1), MAX_ROUTE_COOLDOWN_MS);
    return delay + this.random() * ROUTE_COOLDOWN_JITTER * delay;
  }

  /**
   * Record one upstream fault. A stale in-flight failure (its captured
   * generation is older than the scope's current one) never overwrites a newer
   * fault. The cooldown grows with the scope's consecutive failure count; an
   * upstream-stated reset replaces it and clears the scope when it passes.
   */
  mark(provider: string, model: string, failure: MarkableFailure, status: number, credential: string, guard?: RouteGuard): RouteStatus | undefined {
    const now = this.now();
    const faultKind: RouteFaultKind = failure.faultKind ?? failure.state;
    const { key, scope, pool } = this.scopeFor(provider, model, failure);
    const previous = this.blocks.get(key);
    // Without a tombstone the retired floor is the key's current generation, so a
    // guard captured before that tombstone was evicted is still rejected here.
    const current = this.generations.get(key) ?? this.retiredFloor;
    // Stale-failure guard: the scope changed (a newer fault, or a recovery) after
    // the caller captured it, so a late in-flight failure must not rebuild it.
    const providerKey = this.scopeKey(provider, 'provider');
    const providerGeneration = this.generations.get(providerKey) ?? this.retiredFloor;
    if (guard !== undefined && (current > (guard.generations.get(key) ?? 0)
      || providerGeneration > (guard.generations.get(providerKey) ?? 0))) {
      return previous === undefined ? undefined : this.statusOf(previous);
    }
    if (previous) clearTimeout(previous.timer);
    const boundMs = failure.until === undefined ? undefined : resetInstant(failure.until);
    // Every failure of this scope counts, including passive marks, so repeated
    // faults back off on one schedule until a success clears the scope.
    const failures = (previous?.failures ?? 0) + 1;
    const computed = now + this.backoffMs(failures);
    // An upstream-stated reset overrides the computed cooldown: the scope is
    // blocked exactly until the upstream says it recovers.
    const until = new Date(boundMs === undefined ? computed : Math.max(now + 1, boundMs)).toISOString();
    const generation = this.advanceGeneration(key);
    const block: Block = {
      publicModel: `${provider}/${model}`, provider, scope, ...(pool ? { quotaPoolId: pool } : {}),
      state: failure.state, faultKind, phase: 'open', generation, failures, until, status, resets: boundMs !== undefined,
      ...(failure.state === 'auth_failed' ? { credential: fingerprint(credential) } : {}),
      timer: this.schedule(key, until),
    };
    this.blocks.set(key, block);
    this.pruneGenerations();
    this.emitEvent(block, { state: failure.state, reason: 'upstream_error' });
    return this.statusOf(block);
  }

  /**
   * A validated completed response restores every fault scope that applied when
   * the call started and is still at its captured generation. A success on one
   * model never clears an unrelated model's route fault, and a stale success
   * never clears a fault a newer call recorded.
   */
  success(provider: string, model: string, guard?: RouteGuard): void {
    for (const [key] of this.applying(provider, model, true)) {
      if (guard !== undefined && guard.generations.get(key) !== this.generations.get(key)) continue;
      this.remove(key, 'success', 200);
    }
  }

  /** An auth failure recovers as soon as a different credential is observed. */
  observeCredential(provider: string, value: string): void {
    const current = fingerprint(value);
    for (const [key, block] of this.blocks) {
      if (block.provider === provider && block.credential !== undefined && block.credential !== current) this.remove(key, 'credential_changed');
    }
  }

  /**
   * Drop every fault scope of one provider whose account was deliberately
   * switched: provider, route and pool scoped blocks alike stop blocking the
   * newly bound account immediately. Each removal advances the scope's
   * generation exactly like a recovery, so a failure captured before the
   * switch can never rebuild a cleared fault.
   */
  clearProvider(provider: string): void {
    // Fence every in-flight request, including scopes that have no fault yet.
    this.advanceGeneration(this.scopeKey(provider, 'provider'));
    for (const [key, block] of [...this.blocks]) {
      if (block.provider === provider) this.remove(key, 'credential_changed');
    }
    this.pruneGenerations();
  }

  close(): void {
    for (const block of this.blocks.values()) clearTimeout(block.timer);
    this.blocks.clear();
    this.generations.clear();
  }

  /**
   * Provider states, the route's own state, and states of the pools it draws
   * from. Only blocking scopes are returned unless `withExpired` asks for the
   * expired ones too (their failure count still drives the next backoff).
   */
  private applying(provider: string, model: string, withExpired = false): [string, Block][] {
    const pools = this.pools(provider, model);
    const publicModel = `${provider}/${model}`;
    const result: [string, Block][] = [];
    for (const [key, block] of [...this.blocks]) {
      if (block.provider !== provider) continue;
      // Expiry is recognized on read as well as by the timer, so a delayed or
      // never-fired timer can never leave a route blocked.
      this.expireIfDue(key, block);
      if (!this.blocks.has(key) || (!withExpired && block.phase !== 'open')) continue;
      if (block.scope === 'provider'
        || (block.scope === 'route' && block.publicModel === publicModel)
        || (block.scope === 'pool' && pools.includes(block.quotaPoolId!))) result.push([key, block]);
    }
    return result;
  }

  /**
   * End a block whose `until` passed: a scope with an upstream reset is cleared;
   * a backed-off scope stops blocking but keeps its failure count for the next
   * backoff, until a success clears it.
   */
  private expireIfDue(key: string, block: Block): void {
    if (block.phase !== 'open' || Date.parse(block.until) > this.now()) return;
    if (block.resets) {
      this.remove(key, 'cooldown');
      return;
    }
    block.phase = 'closed';
    this.emit({ ...this.describe(block), state: 'available', phase: 'closed', status: block.status, reason: 'cooldown' });
  }

  /**
   * Every scope key that can apply to a route, whether or not a block currently
   * exists: its provider, its own route, and each pool it draws from.
   */
  private applicableKeys(provider: string, model: string): string[] {
    const keys = [this.scopeKey(provider, 'provider'), this.scopeKey(provider, 'route', model)];
    for (const pool of this.pools(provider, model)) keys.push(this.scopeKey(provider, 'pool', pool));
    return keys;
  }

  private scopeKey(provider: string, scope: Scope, tag = ''): string {
    return JSON.stringify([provider, scope, tag]);
  }

  /**
   * Resolve the exact fault scope a failure claims, mirroring the store's own
   * rule. An unnamed pool failure cannot claim several independent pools, so it
   * binds the route unless the supplier names the pool or the route has exactly one.
   */
  private scopeFor(provider: string, model: string, failure: MarkableFailure): { key: string; scope: Scope; pool?: string } {
    const declared: Scope = failure.state === 'auth_failed' ? 'provider' : failure.state === 'model_unavailable' ? 'route' : failure.scope ?? 'pool';
    const bound = this.pools(provider, model);
    const named = failure.quotaPoolId ? bound.filter((pool) => pool === failure.quotaPoolId) : bound;
    const pool = declared === 'pool' && named.length === 1 ? named[0] : undefined;
    const scope: Scope = declared === 'pool' && !pool ? 'route' : declared;
    return { key: this.scopeKey(provider, scope, pool ?? (scope === 'route' ? model : '')), scope, ...(pool === undefined ? {} : { pool }) };
  }

  /** The most recently generated block; ties resolve to the last one seen. */
  private newest(blocks: readonly Block[]): Block {
    let latest = blocks[0]!;
    for (const block of blocks) if (block.generation >= latest.generation) latest = block;
    return latest;
  }

  /**
   * The availability a caller sees across every blocking scope: the newest
   * fault, blocked until the latest `until` of them all, so a caller woken at
   * that instant is admitted by every scope at once.
   */
  private project(applying: readonly [string, Block][]): RouteStatus {
    const blocks = applying.map(([, block]) => block);
    const until = new Date(Math.max(...blocks.map((block) => Date.parse(block.until)))).toISOString();
    return this.statusOf(this.newest(blocks), until);
  }

  private statusOf(block: Block, until = block.until): RouteStatus {
    return { state: block.state, until, faultKind: block.faultKind, phase: block.phase, ...(block.resets ? { resets: true } : {}) };
  }

  private schedule(key: string, until: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const block = this.blocks.get(key);
      if (!block) return;
      if (Date.parse(block.until) <= this.now()) this.expireIfDue(key, block);
      else block.timer = this.schedule(key, block.until);
    }, Math.min(MAX_TIMER_MS, Math.max(1, Date.parse(until) - this.now())));
    timer.unref?.();
    return timer;
  }

  private remove(key: string, reason: RouteStateChangedEvent['reason'], status?: number, extra?: Partial<RouteStateChangedEvent>): void {
    // Any removal (recovery, credential change) advances the scope's generation
    // so a failure captured before it can never rebuild the cleared fault.
    this.advanceGeneration(key);
    const block = this.blocks.get(key);
    if (!block) {
      this.pruneGenerations();
      return;
    }
    clearTimeout(block.timer);
    this.blocks.delete(key);
    this.pruneGenerations();
    this.emit({ ...this.describe(block), state: 'available', phase: 'closed', status: status ?? block.status, reason, ...(extra ?? {}) });
  }

  private describe(block: Block): Omit<RouteStateChangedEvent, 'state' | 'reason'> {
    return { publicModel: block.publicModel, provider: block.provider, scope: block.scope,
      ...(block.quotaPoolId ? { quotaPoolId: block.quotaPoolId } : {}), status: block.status,
      faultKind: block.faultKind, phase: block.phase };
  }

  /** Emit one state-change event with its retry instant. */
  private emitEvent(block: Block, overrides: Pick<RouteStateChangedEvent, 'state' | 'reason'>): void {
    this.emit({ ...this.describe(block), ...overrides, until: block.until, nextRetryAt: block.until });
  }
}
