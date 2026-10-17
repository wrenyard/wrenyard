/**
 * Local wire contract between the Model Gateway and its in-process callers.
 * Every `x-wrenyard-*` header is consumed by the Gateway and never forwarded
 * upstream. On the response side the official entry-protocol shape and the
 * upstream values are exposed, with one deliberate exception: the
 * `x-wrenyard-admission` header carries structured, Gateway-local
 * admission-refusal metadata so a caller can tell the local circuit refusing a
 * request apart from a real upstream fault without parsing text.
 */
export const GATEWAY_HEADERS = {
  /** Request: unified public reasoning effort the Gateway translates per provider. */
  reasoningEffort: 'x-wrenyard-reasoning-effort',
  /**
   * Request: exact provider selector. The body's `model` field is always the
   * bare registered model id; the provider is a separate dimension. When absent
   * the Gateway admits the request only if exactly one provider offers that
   * registered id on the requested protocol.
   */
  provider: 'x-wrenyard-provider',
  /** Request: call role, recorded on the Gateway event for attribution. */
  callRole: 'x-wrenyard-call-role',
  /** Request: session id, recorded on the Gateway event for attribution. */
  sessionId: 'x-wrenyard-session-id',
  /**
   * Response: the Gateway-local, structured admission-refusal metadata set only
   * when the Gateway's own circuit refuses to admit a request. It is not an
   * upstream value and is never echoed from an upstream response.
   */
  admission: 'x-wrenyard-admission',
} as const;

export const GATEWAY_ROUTE_STATES = ['rate_limited', 'quota_exhausted', 'auth_failed', 'model_unavailable'] as const;
export type GatewayRouteState = (typeof GATEWAY_ROUTE_STATES)[number];

/** Fixed discriminant of a Gateway-local admission refusal. */
export const GATEWAY_ADMISSION_REFUSED = 'admission_refused';

/**
 * The structured, Gateway-local admission-refusal metadata attached to a
 * blocked-admission response. `kind` is a fixed discriminant. `retryAt` is the
 * absolute earliest instant a probe may next be admitted, kept as its own field
 * separate from `faultKind` (the route fault behind the block, never a prompt or
 * raw upstream text). A caller reads this instead of matching response text.
 */
export interface GatewayAdmissionRefusal {
  kind: typeof GATEWAY_ADMISSION_REFUSED;
  /** Absolute earliest instant a probe/recovery may next be admitted (ISO 8601). */
  retryAt: string;
  /** Circuit phase of the blocked scope at the moment of the refusal. */
  phase: GatewayRoutePhase;
  /** The specific route fault behind the block, when one is known. */
  faultKind?: string;
}

/**
 * Parse the `x-wrenyard-admission` value into its structured form. A missing,
 * malformed or mistyped value yields `undefined` rather than a guessed refusal,
 * so a caller never treats arbitrary text as local admission metadata.
 */
export function parseAdmissionRefusal(value: string | null): GatewayAdmissionRefusal | undefined {
  if (value === null || value.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.kind !== GATEWAY_ADMISSION_REFUSED) return undefined;
  if (typeof record.retryAt !== 'string' || record.retryAt === '') return undefined;
  if (record.phase !== 'closed' && record.phase !== 'open' && record.phase !== 'half_open') return undefined;
  return {
    kind: GATEWAY_ADMISSION_REFUSED,
    retryAt: record.retryAt,
    phase: record.phase,
    ...(typeof record.faultKind === 'string' && record.faultKind !== '' ? { faultKind: record.faultKind } : {}),
  };
}

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
