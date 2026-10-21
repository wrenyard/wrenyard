import type { GatewayRouteState, ProviderDefinition, UpstreamRouteFailure } from '@wrenyard/providers/base';

const MAX_TIME_MS = 8.64e15;

/**
 * Route-scoped fault kinds: exactly the explicit upstream meanings the route
 * state may block on (the five legacy states). An outcome without an explicit
 * upstream meaning — an overload, another 5xx, a connection or transport
 * failure, an empty stream, a delivery failure, a timeout, or a 429 without a
 * reset — is reported in request statistics but never blocks a route.
 */
export type RouteFaultKind = GatewayRouteState;

/**
 * A poisoning outcome: it is allowed to mark a route (or its provider/pool)
 * unavailable. It keeps the legacy {@link UpstreamRouteFailure} shape and adds
 * the specific fault kind.
 */
export interface ClassifiedRouteFailure extends UpstreamRouteFailure {
  faultKind: RouteFaultKind;
}

/**
 * An outcome that must be reported but must never poison route availability: a
 * malformed request or a context-window overflow is the caller's fault, not the
 * route's, so it is classified explicitly instead of being left unclassified.
 * A failure without an explicit upstream meaning (overload, other 5xx,
 * connection failures, empty streams, timeouts, a 429 without a reset) is the
 * route's failure in fact but carries no explicit blocking meaning, so it is
 * classified the same way: reported, never poisoned.
 */
export interface NonPoisoningOutcome {
  nonPoisoning: true;
  status: number;
  category: 'request_invalid' | 'context_overflow' | 'client_error' | 'server_error' | 'transport' | 'timeout' | 'empty_stream' | 'other';
}

export type RouteFailureOutcome = ClassifiedRouteFailure | NonPoisoningOutcome;

/** True when an outcome may mark a route unavailable. */
export function isPoisoning(outcome: RouteFailureOutcome): outcome is ClassifiedRouteFailure {
  return (outcome as NonPoisoningOutcome).nonPoisoning !== true;
}

/** Parse an absolute reset instant: epoch seconds, epoch milliseconds or a date string. */
export function resetInstant(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const numeric = Number(value);
  const ms = Number.isFinite(numeric) ? (numeric > 1e11 ? numeric : numeric * 1000) : Date.parse(String(value));
  return Number.isFinite(ms) && ms >= 0 && ms <= MAX_TIME_MS ? ms : undefined;
}

/** `Retry-After`: delay seconds or an HTTP date. */
function retryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null || !value.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return nowMs + seconds * 1000;
  return resetInstant(value);
}

/** `x-ratelimit-reset`: an absolute instant or a duration such as `1m30s`. */
function rateLimitReset(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const absolute = resetInstant(value);
  if (absolute !== undefined && absolute >= nowMs) return absolute;
  const duration = value.trim();
  if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/u.test(duration)) return undefined;
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = [...duration.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/gu)].reduce((sum, match) => sum + Number(match[1]) * units[match[2]!]!, 0);
  return nowMs + ms <= MAX_TIME_MS ? nowMs + ms : undefined;
}

/** The official error `code` an upstream body carries, when it exposes one. */
function codeOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const root = body as Record<string, unknown>;
  const error = root.error !== null && typeof root.error === 'object' && !Array.isArray(root.error)
    ? root.error as Record<string, unknown>
    : root;
  return typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Classify one non-ok HTTP outcome by its own status and headers. Only answers
 * whose meaning is explicit may block a route:
 *
 * - 429 rate limit with a stated reset claims a shared pool until that
 *   instant; a 429 without a reset is reported but never blocks,
 * - 402 quota exhaustion claims a shared pool (backoff),
 * - 401 authentication failure claims the provider (recovered by a credential
 *   change),
 * - 403 access denial claims the provider too (backoff), but is a distinct
 *   state: the server accepted the credential and refused access (a plan,
 *   region or free-tier restriction), which a credential change cannot repair,
 * - 404 model missing claims the exact route (backoff),
 * - 408 request timeout, every 5xx and every other unlisted outcome is
 *   reported but never poisons a route;
 * - a caller-caused 4xx is a request the caller must fix and never poisons a
 *   route; a context-window overflow is recorded under its own non-poisoning
 *   category.
 */
function genericFailure(status: number, headers: Headers, body: unknown, nowMs: number): RouteFailureOutcome | undefined {
  if (status === 429) {
    const reset = retryAfter(headers.get('retry-after'), nowMs) ?? rateLimitReset(headers.get('x-ratelimit-reset'), nowMs);
    if (reset === undefined) return { nonPoisoning: true, status, category: 'client_error' };
    return { state: 'rate_limited', scope: 'pool', faultKind: 'rate_limited', until: new Date(reset).toISOString() };
  }
  if (status === 402) return { state: 'quota_exhausted', scope: 'pool', faultKind: 'quota_exhausted' };
  if (status === 401) return { state: 'auth_failed', scope: 'provider', faultKind: 'auth_failed' };
  if (status === 403) return { state: 'access_denied', scope: 'provider', faultKind: 'access_denied' };
  if (status === 404) return { state: 'model_unavailable', scope: 'route', faultKind: 'model_unavailable' };
  if (status === 408) return { nonPoisoning: true, status, category: 'timeout' };
  if (status >= 500) return { nonPoisoning: true, status, category: 'server_error' };
  if (status >= 400) {
    const code = codeOf(body);
    const category = code === 'context_length_exceeded' || code === 'context_overflow' ? 'context_overflow' : 'request_invalid';
    return { nonPoisoning: true, status, category };
  }
  return undefined;
}

/**
 * Classify an upstream HTTP failure into a fault kind or an explicit
 * non-poisoning category. Generic status/header rules run first and are refined
 * by the supplier's own error-body rule (a narrower pool or an explicit reset).
 * `undefined` means the status was not an HTTP error.
 */
export function classifyRouteOutcome(
  provider: ProviderDefinition,
  modelId: string,
  status: number,
  headers: Headers,
  body: unknown,
  nowMs: number,
): RouteFailureOutcome | undefined {
  const generic = genericFailure(status, headers, body, nowMs);
  const specificRaw = provider.classifyUpstreamError?.({ modelId, status, headers, body, nowMs });
  if (!specificRaw) return generic;
  const specific: ClassifiedRouteFailure = {
    ...specificRaw,
    faultKind: specificRaw.state,
  };
  if (generic !== undefined && !isPoisoning(generic) && !isPoisoning(specific)) return generic;
  if (generic !== undefined && !isPoisoning(generic)) return specific;
  const base = generic as ClassifiedRouteFailure | undefined;
  const merged: ClassifiedRouteFailure = {
    ...base,
    ...specific,
    faultKind: specific.faultKind ?? base?.faultKind ?? specific.state,
  };
  return merged;
}

/**
 * The poisoning classification of an upstream HTTP failure, or `undefined` for a
 * non-poisoning or non-error outcome. This is the exact view the route state
 * store consumes.
 */
export function classifyRouteFailure(provider: ProviderDefinition, modelId: string, status: number, headers: Headers, body: unknown, nowMs: number): ClassifiedRouteFailure | undefined {
  const outcome = classifyRouteOutcome(provider, modelId, status, headers, body, nowMs);
  return outcome !== undefined && isPoisoning(outcome) ? outcome : undefined;
}

/**
 * Classify an official in-stream error frame (an error observed after an HTTP
 * success status) into the same health authority as an HTTP error. Only a
 * frame whose meaning is explicit (a rate limit, quota exhaustion, an access
 * or authentication refusal) is classified; a benign or caller-caused frame
 * (`content_filter`, an invalid request), a timeout, a server fault and an
 * unknown code return `undefined` and never poison a route.
 */
export function classifyStreamFailure(identity: { type?: string; code?: string }): ClassifiedRouteFailure | undefined {
  const token = `${identity.type ?? ''} ${identity.code ?? ''}`.toLowerCase();
  if (token.trim() === '') return undefined;
  if (/rate.?limit/.test(token)) return { state: 'rate_limited', scope: 'pool', faultKind: 'rate_limited' };
  if (/quota|insufficient_quota|billing|payment/.test(token)) return { state: 'quota_exhausted', scope: 'pool', faultKind: 'quota_exhausted' };
  if (/access.?denied|permission|forbidden/.test(token)) return { state: 'access_denied', scope: 'provider', faultKind: 'access_denied' };
  if (/authentication|unauthenticated|unauthorized|invalid.?api.?key|invalid_key|api_key_invalid/.test(token)) return { state: 'auth_failed', scope: 'provider', faultKind: 'auth_failed' };
  return undefined;
}
