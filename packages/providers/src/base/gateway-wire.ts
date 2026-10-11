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
export interface GatewayRouteStatus { state: GatewayRouteState; until: string; }

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
