import { createHash } from 'node:crypto';
import type { GatewayRouteState, GatewayRouteStatus, UpstreamRouteFailure } from '@wrenyard/providers/base';
import { clientTimeoutFailure, resetInstant, transportFailure, type RouteFaultKind } from './route-failure.ts';

type Scope = 'provider' | 'pool' | 'route';

/** Circuit phase of one fault scope. `closed` is healthy. */
export type CircuitPhase = 'closed' | 'open' | 'half_open';

/** Outcome of one bounded half-open recovery probe. */
export type ProbeOutcome = 'success' | 'failure' | 'cancelled';

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
  /** When a half-open trial may next be attempted, when the scope is half-open. */
  nextProbeAt?: string;
  /** The earliest instant this scope may be retried (until, or the probe time). */
  nextRetryAt?: string;
  /** The outcome of the most recent half-open probe, when one ran. */
  probe?: ProbeOutcome;
  status: number;
  reason: 'upstream_error' | 'cooldown' | 'success' | 'credential_changed' | 'half_open';
}

/** The route health a caller reads: the legacy status plus the circuit detail. */
export interface RouteStatus extends GatewayRouteStatus {
  faultKind?: RouteFaultKind;
  phase: CircuitPhase;
  nextProbeAt?: string;
  lastProbe?: ProbeOutcome;
}

/**
 * A captured view of every fault scope that applied when a call started. A
 * completion may only clear or overwrite the exact generations it observed, so
 * a stale in-flight success or failure cannot overwrite a newer fault.
 */
export interface RouteGuard {
  readonly generations: ReadonlyMap<string, number>;
}

/** One fault scope a probe lease covers, fenced by generation and lease token. */
export interface ProbeLeaseEntry {
  readonly key: string;
  readonly generation: number;
  readonly token: number;
  readonly scope: Scope;
}

/**
 * An exclusive, time-bounded lease to run one real-request recovery probe. A
 * route may be blocked by several scopes at once (provider, pool, route), so a
 * single lease atomically covers every applicable scope: while it is held no
 * other caller may admit or probe any of them.
 */
export interface ProbeLease {
  readonly provider: string;
  readonly model: string;
  /** The client attempt this probe is attached to, when the request carried one. */
  readonly attemptId?: string;
  /** When this bounded lease expires (epoch ms); the probe's own lifetime is bounded by it. */
  readonly expiresAt: number;
  readonly entries: readonly ProbeLeaseEntry[];
}

/** The admission decision for one route, taken before any upstream call. */
export type Admission =
  | { kind: 'admit'; guard: RouteGuard }
  | { kind: 'probe'; guard: RouteGuard; lease: ProbeLease }
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
  /** Consecutive failed half-open probes; drives the exponential backoff. */
  probeFailures: number;
  /** When the next half-open trial may be attempted. */
  nextProbeAt?: string;
  lastProbe?: ProbeOutcome;
  /** Upstream not-before / `Retry-After` floor preserved across failed probes. */
  boundUntil?: number;
  /** Fingerprint of the credential an auth failure was observed with. */
  credential?: string;
  /** Unique lease token while a half-open probe holds this scope. */
  leaseToken?: number;
  /** When the held probe lease expires, so reads can project a future retry. */
  leaseUntil?: number;
  timer: ReturnType<typeof setTimeout>;
  leaseTimer?: ReturnType<typeof setTimeout>;
}

/** A failure the store may record: the legacy shape plus an optional fault kind. */
export type MarkableFailure = UpstreamRouteFailure & { faultKind?: RouteFaultKind };

/** The client-observed fault kinds the attempt-correlated feedback API accepts. */
export type ClientFaultKind = 'timeout' | 'transport';

/** One in-flight attempt, correlated by the client so a duplicate report is dropped. */
interface Attempt {
  readonly generations: Map<string, number>;
  settled: boolean;
  expiresAt: number;
  /** The probe lease this attempt was admitted with, when it was admitted as one. */
  lease?: ProbeLease;
}

const RATE_LIMIT_FALLBACK_MS = 60_000;
const FAILURE_FALLBACK_MS = 30 * 60_000;
/** Initial cooldown of a route-scoped timeout/transport/5xx fault. */
const ROUTE_FAULT_COOLDOWN_MS = 60_000;
/** Hard cap of the exponential backoff after repeated failed half-open probes. */
const MAX_ROUTE_COOLDOWN_MS = 10 * 60_000;
/** A probe lease is always bounded: a stalled probe never blocks others forever. */
const PROBE_LEASE_MS = 60_000;
/**
 * Backstop after the logical lease expiry. The probe holder bounds and aborts its
 * own request at {@link PROBE_LEASE_MS}, so freeing the token only a grace later
 * guarantees a replacement probe never starts before the old one was aborted.
 */
const PROBE_LEASE_GRACE_MS = 5_000;
/** Idle attempts are expired so attempt bookkeeping stays bounded over a long run. */
const ATTEMPT_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 4_096;
const MAX_TIMER_MS = 2_147_483_647;

const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The initial cooldown of a fresh fault, before any probe backoff. */
function initialCooldownMs(faultKind: RouteFaultKind): number {
  if (faultKind === 'rate_limited') return RATE_LIMIT_FALLBACK_MS;
  if (faultKind === 'timeout' || faultKind === 'transport' || faultKind === 'server_error') return ROUTE_FAULT_COOLDOWN_MS;
  return FAILURE_FALLBACK_MS;
}

/** The fault a client-observed kind maps to: the exact route that observed it. */
function clientFailure(kind: ClientFaultKind): MarkableFailure {
  return kind === 'timeout' ? clientTimeoutFailure() : transportFailure();
}

/**
 * In-memory route health of one Gateway process, and the single authority for
 * auxiliary routing. Reads never trigger provider work: credentials are observed
 * only where the Gateway already reads them. A fault scope stays faulted until a
 * validated completed response restores it; cooldown expiry only makes it
 * eligible for one bounded half-open trial.
 */
export class RouteStateStore {
  private readonly blocks = new Map<string, Block>();
  /** Latest generation per scope key; never deleted so late completions can be rejected. */
  private readonly generations = new Map<string, number>();
  /** In-flight attempts by `provider/model#attemptId`, bounded by count and TTL. */
  private readonly attempts = new Map<string, Attempt>();
  private leaseSeq = 0;

  constructor(
    private readonly now: () => number,
    private readonly pools: (provider: string, model: string) => readonly string[],
    private readonly emit: (event: RouteStateChangedEvent) => void,
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
    for (const key of this.applicableKeys(provider, model)) generations.set(key, this.generations.get(key) ?? 0);
    return { generations };
  }

  /**
   * Admit one call before any upstream traffic. Every applicable scope must be
   * healthy or half-open-and-free: an open or already-leased scope blocks the
   * call. Exactly one caller may hold the atomic multi-scope probe lease. When an
   * `attemptId` is given the probe lease is attached to that same attempt, so the
   * client report and the pipeline settlement settle it exactly once.
   */
  admit(provider: string, model: string, attemptId?: string): Admission {
    const applying = this.applying(provider, model);
    const guard = this.capture(provider, model);
    if (applying.length === 0) return { kind: 'admit', guard };
    const open = applying.filter(([, block]) => block.phase === 'open');
    if (open.length > 0) return { kind: 'blocked', status: this.project(applying) };
    const leased = applying.filter(([, block]) => block.leaseToken !== undefined);
    if (leased.length > 0) return { kind: 'blocked', status: this.project(applying) };
    const lease = this.acquireProbe(provider, model, attemptId);
    if (lease !== undefined) return { kind: 'probe', guard, lease };
    return { kind: 'blocked', status: this.project(applying) };
  }

  /**
   * Record a client-observed route fault (a timeout or fetch failure the
   * Gateway only saw as a disconnect) into the same store, correlated to the
   * attempt that observed it. A fault is only recorded while the attempt is
   * unsettled, so a client report and a server-side timeout of the same attempt
   * are never double counted.
   */
  reportAttemptFault(provider: string, model: string, attemptId: string, kind: ClientFaultKind, status: number, until?: string): RouteStatus | undefined {
    this.pruneAttempts();
    const attempt = this.attempts.get(this.attemptKey(provider, model, attemptId));
    if (attempt?.settled === true) return undefined;
    const failure: MarkableFailure = { ...clientFailure(kind), ...(until === undefined ? {} : { until }) };
    // A client report of an attempt that was admitted as a probe settles that
    // very probe (one backoff), so the pipeline's own settlement is fenced out.
    if (attempt?.lease !== undefined) {
      this.releaseProbe(attempt.lease, 'failure', failure, status);
      return this.status(provider, model);
    }
    const guard: RouteGuard | undefined = attempt === undefined ? undefined : { generations: attempt.generations };
    const result = this.mark(provider, model, failure, status, '', guard);
    if (attempt !== undefined) attempt.settled = true;
    return result;
  }

  /** Begin one attempt, capturing the fault generations it observes. */
  beginAttempt(provider: string, model: string, attemptId: string): void {
    this.pruneAttempts();
    const key = this.attemptKey(provider, model, attemptId);
    this.attempts.delete(key);
    this.attempts.set(key, { generations: new Map(this.capture(provider, model).generations), settled: false, expiresAt: this.now() + ATTEMPT_TTL_MS });
    this.boundAttempts();
  }

  /**
   * Finish one attempt. The settled tombstone is kept for a bounded TTL so a
   * late client report of the same attempt is ignored, and is evicted after.
   */
  completeAttempt(provider: string, model: string, attemptId: string, settled = true): void {
    this.pruneAttempts();
    const attempt = this.attempts.get(this.attemptKey(provider, model, attemptId));
    if (attempt !== undefined) { attempt.settled = settled; attempt.lease = undefined; }
  }

  /**
   * Record an upstream fault attributed to an attempt, through the same
   * classification path as a passive fault. A settled attempt is ignored in
   * either order, so a client report and the server-side fault of the same
   * attempt are never double counted. An ignored settlement returns nothing.
   */
  markAttemptFault(provider: string, model: string, attemptId: string, failure: MarkableFailure, status: number, credential: string, guard?: RouteGuard): RouteStatus | undefined {
    this.pruneAttempts();
    if (this.attempts.get(this.attemptKey(provider, model, attemptId))?.settled === true) return undefined;
    const result = this.mark(provider, model, failure, status, credential, guard);
    this.completeAttempt(provider, model, attemptId);
    return result;
  }

  /** Settle one attempt without recording anything; a late duplicate is then dropped. */
  private settleAttempt(provider: string, model: string, attemptId: string): void {
    const attempt = this.attempts.get(this.attemptKey(provider, model, attemptId));
    if (attempt !== undefined) { attempt.settled = true; attempt.lease = undefined; }
  }

  private attemptKey(provider: string, model: string, attemptId: string): string {
    return `${provider}/${model}#${attemptId}`;
  }

  private pruneAttempts(): void {
    const now = this.now();
    for (const [key, attempt] of this.attempts) if (attempt.expiresAt <= now) this.attempts.delete(key);
  }

  private boundAttempts(): void {
    while (this.attempts.size > MAX_ATTEMPTS) {
      const oldest = this.attempts.keys().next().value;
      if (oldest === undefined) return;
      this.attempts.delete(oldest);
    }
  }

  /**
   * Acquire the single bounded lease that may run a real-request half-open probe
   * across every applicable scope. It is taken atomically: if any applicable
   * scope is open or already leased, none is leased and `undefined` is returned.
   * The lease is attached to `attemptId` when one is given.
   */
  acquireProbe(provider: string, model: string, attemptId?: string): ProbeLease | undefined {
    const now = this.now();
    const applying = this.applying(provider, model);
    if (applying.length === 0) return undefined;
    for (const [, block] of applying) {
      if (block.phase !== 'half_open' || block.leaseToken !== undefined) return undefined;
      if (block.nextProbeAt !== undefined && Date.parse(block.nextProbeAt) > now) return undefined;
    }
    const expiresAt = now + PROBE_LEASE_MS;
    const entries: ProbeLeaseEntry[] = [];
    for (const [key, block] of applying) {
      const token = (this.leaseSeq += 1);
      block.leaseToken = token;
      block.leaseUntil = expiresAt;
      if (block.leaseTimer !== undefined) clearTimeout(block.leaseTimer);
      // The holder bounds and aborts its own request at `expiresAt`; this timer
      // is only the backstop that frees the token a grace later.
      block.leaseTimer = setTimeout(() => { this.expireLease(key, token); }, PROBE_LEASE_MS + PROBE_LEASE_GRACE_MS);
      block.leaseTimer.unref?.();
      entries.push({ key, generation: block.generation, token, scope: block.scope });
    }
    const lease: ProbeLease = { provider, model, expiresAt, entries, ...(attemptId === undefined ? {} : { attemptId }) };
    if (attemptId !== undefined) {
      const attempt = this.attempts.get(this.attemptKey(provider, model, attemptId));
      if (attempt !== undefined && !attempt.settled) attempt.lease = lease;
    }
    return lease;
  }

  /**
   * Release a probe lease with its outcome. Every scope it covers is fenced by
   * both the fault generation and the lease token, so an expired and reacquired
   * lease can never be cleared by a stale completion. `success` restores health;
   * `failure` adopts the classified fault the probe observed and backs the
   * cooldown off exponentially (capped at ten minutes); `cancelled` or an omitted
   * outcome (expiry, shutdown) leaves the scope half-open for a later trial. When
   * the lease is attached to an attempt, that attempt settles in the same step.
   */
  releaseProbe(lease: ProbeLease, outcome?: ProbeOutcome, failure?: MarkableFailure, status?: number): void {
    let settled = false;
    for (const entry of lease.entries) {
      const block = this.blocks.get(entry.key);
      if (!block || block.generation !== entry.generation || block.leaseToken !== entry.token) continue;
      if (block.leaseTimer !== undefined) { clearTimeout(block.leaseTimer); block.leaseTimer = undefined; }
      block.leaseToken = undefined;
      block.leaseUntil = undefined;
      if (outcome === undefined) continue;
      settled = true;
      this.settleProbe(entry.key, block, outcome, failure, status);
    }
    // A failed probe can discover a scope the lease did not cover (an auth
    // provider scope, a rate-limit pool); that genuinely new scope takes effect too.
    if (settled && outcome === 'failure' && failure !== undefined) this.discoverScope(lease, failure, status);
    if (outcome !== undefined && lease.attemptId !== undefined) this.settleAttempt(lease.provider, lease.model, lease.attemptId);
  }

  /** Release only the lease token that is still current; a newer lease is untouched. */
  private expireLease(key: string, token: number): void {
    const block = this.blocks.get(key);
    if (block !== undefined && block.leaseToken === token) block.leaseToken = undefined;
  }

  /**
   * Settle one covered scope with the probe's outcome. A failure is a fresh open
   * circuit carrying the fault the probe observed and a longer cooldown, never
   * shorter than the original not-before / `Retry-After` bound.
   */
  private settleProbe(key: string, block: Block, outcome: ProbeOutcome, failure?: MarkableFailure, status?: number): void {
    block.lastProbe = outcome;
    if (outcome === 'success') {
      this.remove(key, 'success', 200, { probe: 'success', phase: 'closed' });
      return;
    }
    if (outcome === 'cancelled') {
      this.emitEvent(block, { state: block.state, reason: 'half_open', probe: 'cancelled' });
      return;
    }
    block.probeFailures += 1;
    block.phase = 'open';
    block.nextProbeAt = undefined;
    if (failure !== undefined) {
      block.faultKind = failure.faultKind ?? failure.state;
      block.state = failure.state;
      if (status !== undefined) block.status = status;
    }
    const boundMs = failure?.until === undefined ? undefined : resetInstant(failure.until);
    if (boundMs !== undefined) block.boundUntil = Math.max(block.boundUntil ?? 0, boundMs);
    const floor = Math.max(this.now() + this.backoffMs(block.probeFailures), block.boundUntil ?? 0);
    block.until = new Date(floor).toISOString();
    clearTimeout(block.timer);
    block.timer = this.schedule(key, block.until);
    this.emitEvent(block, { state: block.state, reason: 'upstream_error', probe: 'failure' });
  }

  /**
   * Bring a failed probe's own fault scope into effect when the lease did not
   * already cover it, so a probe that discovers a shared pool or provider fault
   * faults that scope exactly as a passive call would.
   */
  private discoverScope(lease: ProbeLease, failure: MarkableFailure, status?: number): void {
    const key = this.scopeFor(lease.provider, lease.model, failure).key;
    if (lease.entries.some((entry) => entry.key === key)) return;
    this.mark(lease.provider, lease.model, failure, status ?? 502, '');
  }

  /** The exponential backoff of repeated failed probes, capped at ten minutes. */
  private backoffMs(probeFailures: number): number {
    return Math.min(ROUTE_FAULT_COOLDOWN_MS * 2 ** Math.max(0, probeFailures - 1), MAX_ROUTE_COOLDOWN_MS);
  }

  /**
   * Record one upstream fault. A stale in-flight failure (its captured
   * generation is older than the scope's current one) never overwrites a newer
   * fault. The cooldown is the initial window for the fault kind, always honoring
   * a later upstream not-before bound or `Retry-After`, which is preserved as a
   * floor across later failed probes.
   */
  mark(provider: string, model: string, failure: MarkableFailure, status: number, credential: string, guard?: RouteGuard): RouteStatus | undefined {
    const now = this.now();
    const faultKind: RouteFaultKind = failure.faultKind ?? failure.state;
    const { key, scope, pool } = this.scopeFor(provider, model, failure);
    const previous = this.blocks.get(key);
    const current = this.generations.get(key) ?? 0;
    // Stale-failure guard: the scope changed (a newer fault, or a recovery) after
    // the caller captured it, so a late in-flight failure must not rebuild it.
    if (guard !== undefined && current > (guard.generations.get(key) ?? 0)) {
      return previous === undefined ? undefined : this.statusOf(previous);
    }
    if (previous) clearTimeout(previous.timer);
    if (previous?.leaseTimer !== undefined) clearTimeout(previous.leaseTimer);
    const boundMs = failure.until === undefined ? undefined : resetInstant(failure.until);
    const computed = now + initialCooldownMs(faultKind);
    const until = new Date(boundMs === undefined ? computed : Math.max(computed, boundMs)).toISOString();
    const generation = current + 1;
    this.generations.set(key, generation);
    const block: Block = {
      publicModel: `${provider}/${model}`, provider, scope, ...(pool ? { quotaPoolId: pool } : {}),
      state: failure.state, faultKind, phase: 'open', generation, probeFailures: 0, until, status,
      ...(boundMs !== undefined && boundMs > computed ? { boundUntil: boundMs } : {}),
      ...(failure.state === 'auth_failed' ? { credential: fingerprint(credential) } : {}),
      timer: this.schedule(key, until),
    };
    this.blocks.set(key, block);
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
    for (const [key] of this.applying(provider, model)) {
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

  close(): void {
    for (const block of this.blocks.values()) {
      clearTimeout(block.timer);
      if (block.leaseTimer !== undefined) clearTimeout(block.leaseTimer);
    }
    this.blocks.clear();
    this.attempts.clear();
  }

  /** Provider states, the route's own state, and states of the pools it draws from. */
  private applying(provider: string, model: string): [string, Block][] {
    const pools = this.pools(provider, model);
    const publicModel = `${provider}/${model}`;
    const result: [string, Block][] = [];
    for (const [key, block] of this.blocks) {
      if (block.provider !== provider) continue;
      // Cooldown expiry is recognized on read as well as by the timer, so a
      // delayed or never-fired timer can never leave a route stuck open.
      this.refreshHalfOpen(key, block);
      if (block.scope === 'provider'
        || (block.scope === 'route' && block.publicModel === publicModel)
        || (block.scope === 'pool' && pools.includes(block.quotaPoolId!))) result.push([key, block]);
    }
    return result;
  }

  /** Transition an expired open circuit to half-open (idempotent). */
  private refreshHalfOpen(key: string, block: Block): void {
    if (block.phase === 'open' && Date.parse(block.until) <= this.now()) this.enterHalfOpen(key);
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
   * The availability a caller actually sees across every applicable scope: an
   * open scope blocks first, a still-leased probe is not probeable, and the
   * earliest safe retry satisfies every scope at once. A held lease is projected
   * as a future `nextProbeAt` so its retry is never reported as zero.
   */
  private project(applying: readonly [string, Block][]): RouteStatus {
    const blocks = applying.map(([, block]) => block);
    const open = blocks.filter((block) => block.phase === 'open');
    const leased = blocks.filter((block) => block.leaseToken !== undefined);
    const representative = this.newest(open.length > 0 ? open : leased.length > 0 ? leased : blocks);
    const until = new Date(Math.max(...blocks.map((block) => Date.parse(block.until)))).toISOString();
    if (open.length > 0) return this.statusOf(representative, until);
    const nextProbeAt = leased.length > 0
      ? new Date(Math.max(this.now() + 1, ...leased.map((block) => block.leaseUntil ?? this.now() + PROBE_LEASE_MS))).toISOString()
      : new Date(Math.max(...blocks.map((block) => block.nextProbeAt === undefined ? 0 : Date.parse(block.nextProbeAt)))).toISOString();
    return this.statusOf(representative, until, nextProbeAt);
  }

  private statusOf(block: Block, until = block.until, nextProbeAt = block.nextProbeAt): RouteStatus {
    const retry = nextProbeAt ?? until;
    return {
      state: block.state, until, faultKind: block.faultKind, phase: block.phase,
      ...(retry === undefined ? {} : { nextProbeAt: retry }),
      ...(block.lastProbe === undefined ? {} : { lastProbe: block.lastProbe }),
    };
  }

  private schedule(key: string, until: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const block = this.blocks.get(key);
      if (!block) return;
      if (Date.parse(block.until) <= this.now()) this.enterHalfOpen(key);
      else block.timer = this.schedule(key, block.until);
    }, Math.min(MAX_TIMER_MS, Math.max(1, Date.parse(until) - this.now())));
    timer.unref?.();
    return timer;
  }

  /** Cooldown expiry is eligibility for a half-open trial, never health. */
  private enterHalfOpen(key: string): void {
    const block = this.blocks.get(key);
    if (!block || block.phase === 'half_open') return;
    block.phase = 'half_open';
    block.nextProbeAt = new Date(this.now()).toISOString();
    block.until = block.nextProbeAt;
    this.emitEvent(block, { state: block.state, reason: 'half_open' });
  }

  private remove(key: string, reason: RouteStateChangedEvent['reason'], status?: number, extra?: Partial<RouteStateChangedEvent>): void {
    // Any removal (recovery, credential change) advances the scope's generation
    // so a failure captured before it can never rebuild the cleared fault.
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    const block = this.blocks.get(key);
    if (!block) return;
    clearTimeout(block.timer);
    if (block.leaseTimer !== undefined) clearTimeout(block.leaseTimer);
    this.blocks.delete(key);
    this.emit({ ...this.describe(block), state: 'available', phase: 'closed', status: status ?? block.status, reason, ...(extra ?? {}) });
  }

  private describe(block: Block): Omit<RouteStateChangedEvent, 'state' | 'reason'> {
    return { publicModel: block.publicModel, provider: block.provider, scope: block.scope,
      ...(block.quotaPoolId ? { quotaPoolId: block.quotaPoolId } : {}), status: block.status,
      faultKind: block.faultKind, phase: block.phase };
  }

  /** Emit one state-change event with its retry/probe facts resolved. */
  private emitEvent(block: Block, overrides: Pick<RouteStateChangedEvent, 'state' | 'reason'> & { probe?: ProbeOutcome }): void {
    const nextProbeAt = block.nextProbeAt;
    this.emit({
      ...this.describe(block), ...overrides,
      until: block.until,
      ...(nextProbeAt === undefined ? {} : { nextProbeAt, nextRetryAt: nextProbeAt }),
      ...(nextProbeAt === undefined ? { nextRetryAt: block.until } : {}),
    });
  }
}
