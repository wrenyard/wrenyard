/**
 * Local wire contract between the Model Gateway and its in-process callers.
 * Every `x-wrenyard-*` header is consumed by the Gateway and never forwarded
 * upstream; response headers are additive and safe for external clients to ignore.
 */
export const GATEWAY_HEADERS = {
  /** Request: unified public reasoning effort the Gateway translates per provider. */
  reasoningEffort: 'x-wrenyard-reasoning-effort',
  /** Request: call role, recorded on the Gateway event for attribution. */
  callRole: 'x-wrenyard-call-role',
  /** Request: session id, recorded on the Gateway event for attribution. */
  sessionId: 'x-wrenyard-session-id',
  /** Response: route state the Gateway recognized from the upstream failure. */
  routeState: 'x-wrenyard-route-state',
  /** Response: ISO instant the route is expected to recover. */
  routeUntil: 'x-wrenyard-route-until',
  /** Response: the Gateway itself rejected the request; retrying cannot help. */
  requestError: 'x-wrenyard-request-error',
} as const;

export const GATEWAY_ROUTE_STATES = ['rate_limited', 'quota_exhausted', 'auth_failed', 'model_unavailable'] as const;
export type GatewayRouteState = (typeof GATEWAY_ROUTE_STATES)[number];
export interface GatewayRouteStatus { state: GatewayRouteState; until: string; }

export function parseGatewayRouteState(value: string | null | undefined): GatewayRouteState | undefined {
  return (GATEWAY_ROUTE_STATES as readonly (string | null | undefined)[]).includes(value) ? value as GatewayRouteState : undefined;
}
