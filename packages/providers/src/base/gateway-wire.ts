/**
 * Local wire contract between the Model Gateway and its in-process callers.
 * Every `x-wrenyard-*` header is consumed by the Gateway and never forwarded
 * upstream. The Gateway owns no private response header: on the response side
 * only the official entry-protocol shape and upstream values are exposed.
 */
export const GATEWAY_HEADERS = {
  /** Request: unified public reasoning effort the Gateway translates per provider. */
  reasoningEffort: 'x-wrenyard-reasoning-effort',
  /** Request: call role, recorded on the Gateway event for attribution. */
  callRole: 'x-wrenyard-call-role',
  /** Request: session id, recorded on the Gateway event for attribution. */
  sessionId: 'x-wrenyard-session-id',
} as const;

export const GATEWAY_ROUTE_STATES = ['rate_limited', 'quota_exhausted', 'auth_failed', 'model_unavailable'] as const;
export type GatewayRouteState = (typeof GATEWAY_ROUTE_STATES)[number];

/** Circuit phase of one route: `closed` is healthy, `open` faulted, `half_open` probing. */
export type GatewayRoutePhase = 'closed' | 'open' | 'half_open';

/**
 * The health of one public route as an in-process caller reads it. `state` and
 * `until` are the legacy block; the circuit detail is optional so a producer
 * that only reports open blocks stays valid. `phase` distinguishes an open
 * circuit from a half-open route that may run one bounded recovery probe;
 * `nextProbeAt` is when such a probe may next be admitted. `faultKind` names the
 * fault behind the block (a timeout, transport, server, rate-limit or auth
 * reason), never a prompt or raw upstream text.
 */
export interface GatewayRouteStatus {
  state: GatewayRouteState;
  until: string;
  phase?: GatewayRoutePhase;
  nextProbeAt?: string;
  faultKind?: string;
}

/**
 * Upstream response headers the Gateway forwards to a client. Values are
 * copied verbatim from the upstream response and are never synthesized: a
 * header absent upstream stays absent, and `retry-after` / `retry-after-ms` /
 * `x-should-retry` are reported exactly as the supplier sent them so a caller's
 * own retry policy can read the protocol-defined hint.
 */
export const GATEWAY_UPSTREAM_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'cache-control', 'content-type', 'openai-organization', 'openai-processing-ms',
  'openai-version', 'request-id', 'x-request-id',
  'retry-after', 'retry-after-ms', 'x-should-retry',
  'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
]);
