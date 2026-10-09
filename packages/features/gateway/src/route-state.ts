import { createHash } from 'node:crypto';
import type { GatewayRouteState, GatewayRouteStatus, UpstreamRouteFailure } from '@wrenyard/providers/base';
import { resetInstant } from './route-failure.ts';

type Scope = 'provider' | 'pool' | 'route';

export interface RouteStateChangedEvent {
  publicModel: string;
  provider: string;
  scope: Scope;
  quotaPoolId?: string;
  state: GatewayRouteState | 'available';
  until?: string;
  status: number;
  reason: 'upstream_error' | 'cooldown' | 'success' | 'credential_changed';
}

interface Block extends GatewayRouteStatus {
  publicModel: string;
  provider: string;
  scope: Scope;
  quotaPoolId?: string;
  status: number;
  /** Fingerprint of the credential an auth failure was observed with. */
  credential?: string;
  timer: ReturnType<typeof setTimeout>;
}

const RATE_LIMIT_FALLBACK_MS = 60_000;
const FAILURE_FALLBACK_MS = 30 * 60_000;
const MAX_TIMER_MS = 2_147_483_647;

const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * In-memory route states of one Gateway process. Reads never trigger provider
 * work: credentials are observed only where the Gateway already reads them.
 */
export class RouteStateStore {
  private readonly blocks = new Map<string, Block>();

  constructor(
    private readonly now: () => number,
    private readonly pools: (provider: string, model: string) => readonly string[],
    private readonly emit: (event: RouteStateChangedEvent) => void,
  ) {}

  status(provider: string, model: string): GatewayRouteStatus | undefined {
    const now = this.now();
    let latest: Block | undefined;
    for (const [, block] of this.applying(provider, model)) {
      if (Date.parse(block.until) > now && (!latest || Date.parse(block.until) > Date.parse(latest.until))) latest = block;
    }
    return latest && { state: latest.state, until: latest.until };
  }

  mark(provider: string, model: string, failure: UpstreamRouteFailure, status: number, credential: string): GatewayRouteStatus {
    const until = new Date(resetInstant(failure.until)
      ?? this.now() + (failure.state === 'rate_limited' ? RATE_LIMIT_FALLBACK_MS : FAILURE_FALLBACK_MS)).toISOString();
    const declared: Scope = failure.state === 'auth_failed' ? 'provider' : failure.state === 'model_unavailable' ? 'route' : failure.scope ?? 'pool';
    // An unnamed pool failure cannot claim several independent pools; it binds
    // the route unless the supplier names the pool or the route has exactly one.
    const bound = this.pools(provider, model);
    const named = failure.quotaPoolId ? bound.filter(pool => pool === failure.quotaPoolId) : bound;
    const pool = declared === 'pool' && named.length === 1 ? named[0] : undefined;
    const scope: Scope = declared === 'pool' && !pool ? 'route' : declared;
    const key = JSON.stringify([provider, scope, pool ?? (scope === 'route' ? model : '')]);
    const previous = this.blocks.get(key);
    if (previous) clearTimeout(previous.timer);
    const block: Block = {
      publicModel: `${provider}/${model}`, provider, scope, ...(pool ? { quotaPoolId: pool } : {}),
      state: failure.state, until, status,
      ...(failure.state === 'auth_failed' ? { credential: fingerprint(credential) } : {}),
      timer: this.schedule(key, until),
    };
    this.blocks.set(key, block);
    this.emit({ ...this.describe(block), state: failure.state, until, reason: 'upstream_error' });
    return { state: failure.state, until };
  }

  /** Any successful response clears every state that applies to the route. */
  success(provider: string, model: string): void {
    for (const [key] of this.applying(provider, model)) this.remove(key, 'success', 200);
  }

  /** An auth failure recovers as soon as a different credential is observed. */
  observeCredential(provider: string, value: string): void {
    const current = fingerprint(value);
    for (const [key, block] of this.blocks) {
      if (block.provider === provider && block.credential !== undefined && block.credential !== current) this.remove(key, 'credential_changed');
    }
  }

  close(): void {
    for (const block of this.blocks.values()) clearTimeout(block.timer);
    this.blocks.clear();
  }

  /** Provider states, the route's own state, and states of the pools it draws from. */
  private applying(provider: string, model: string): [string, Block][] {
    const pools = this.pools(provider, model);
    const publicModel = `${provider}/${model}`;
    return [...this.blocks].filter(([, block]) => block.provider === provider && (block.scope === 'provider'
      || (block.scope === 'route' && block.publicModel === publicModel)
      || (block.scope === 'pool' && pools.includes(block.quotaPoolId!))));
  }

  private schedule(key: string, until: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const block = this.blocks.get(key);
      if (!block) return;
      if (Date.parse(block.until) <= this.now()) this.remove(key, 'cooldown');
      else block.timer = this.schedule(key, block.until);
    }, Math.min(MAX_TIMER_MS, Math.max(1, Date.parse(until) - this.now())));
    timer.unref?.();
    return timer;
  }

  private remove(key: string, reason: RouteStateChangedEvent['reason'], status?: number): void {
    const block = this.blocks.get(key);
    if (!block) return;
    clearTimeout(block.timer);
    this.blocks.delete(key);
    this.emit({ ...this.describe(block), state: 'available', status: status ?? block.status, reason });
  }

  private describe(block: Block): Omit<RouteStateChangedEvent, 'state' | 'reason'> {
    return { publicModel: block.publicModel, provider: block.provider, scope: block.scope,
      ...(block.quotaPoolId ? { quotaPoolId: block.quotaPoolId } : {}), status: block.status };
  }
}
