import type { GatewayRouteState, ProviderDefinition, UpstreamRouteFailure } from '@wrenyard/providers/base';

const MAX_TIME_MS = 8.64e15;

/**
 * Route-scoped fault kinds: the four legacy states plus the transport classes
 * that a route-scoped (provider/model) fault can carry. A transport fault is
 * isolated to the exact model that observed it; a rate limit or quota fault
 * keeps its shared pool scope.
 */
export type RouteFaultKind = GatewayRouteState | 'timeout' | 'transport' | 'server_error';

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
 */
export interface NonPoisoningOutcome {
  nonPoisoning: true;
  status: number;
  category: 'request_invalid' | 'context_overflow' | 'client_error' | 'other';
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
 * Classify one non-ok HTTP outcome by its own status and headers. The mapping is
 * fixed and identical for every supplier:
 *
 * - 429 rate limit / 402 quota exhaustion claim a shared pool,
 * - 401/403 auth failure claims the provider (recovered by a credential change),
 * - 404 model missing claims the exact route,
 * - 408 request timeout and every 5xx claim the exact route (transport class),
 * - every other 4xx is a request the caller must fix and never poisons a route;
 *   a context-window overflow is recorded under its own non-poisoning category.
 */
function genericFailure(status: number, headers: Headers, body: unknown, nowMs: number): RouteFailureOutcome | undefined {
  if (status === 429) {
    const reset = retryAfter(headers.get('retry-after'), nowMs) ?? rateLimitReset(headers.get('x-ratelimit-reset'), nowMs);
    return { state: 'rate_limited', scope: 'pool', faultKind: 'rate_limited', ...(reset === undefined ? {} : { until: new Date(reset).toISOString() }) };
  }
  if (status === 402) return { state: 'quota_exhausted', scope: 'pool', faultKind: 'quota_exhausted' };
  if (status === 401 || status === 403) return { state: 'auth_failed', scope: 'provider', faultKind: 'auth_failed' };
  if (status === 404) return { state: 'model_unavailable', scope: 'route', faultKind: 'model_unavailable' };
  if (status === 408) return { state: 'model_unavailable', scope: 'route', faultKind: 'timeout' };
  if (status >= 500) return { state: 'model_unavailable', scope: 'route', faultKind: 'server_error' };
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
  // A caller-caused failure is final: a supplier rule can never turn a bad
  // request into a route fault.
  if (generic !== undefined && !isPoisoning(generic)) return generic;
  const specific = provider.classifyUpstreamError?.({ modelId, status, headers, body, nowMs });
  if (!specific) return generic;
  const base = generic as ClassifiedRouteFailure | undefined;
  const merged: ClassifiedRouteFailure = {
    ...base,
    ...specific,
    faultKind: (specific as { faultKind?: RouteFaultKind }).faultKind ?? base?.faultKind ?? specific.state,
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

/** The exact route a client-observed timeout must be isolated to. */
export function clientTimeoutFailure(): ClassifiedRouteFailure {
  return { state: 'model_unavailable', scope: 'route', faultKind: 'timeout' };
}

/** The exact route a client-observed transport/fetch failure must be isolated to. */
export function transportFailure(): ClassifiedRouteFailure {
  return { state: 'model_unavailable', scope: 'route', faultKind: 'transport' };
}

/**
 * Classify an official in-stream error frame (an error observed after an HTTP
 * success status) into the same health authority as an HTTP error, so a stream
 * failure and a non-ok response agree on the scope they poison. Only a fault the
 * route itself owns is classified; a benign or caller-caused frame
 * (`content_filter`, an invalid request, an unknown code) returns `undefined`
 * and never poisons a route.
 */
export function classifyStreamFailure(identity: { type?: string; code?: string }): ClassifiedRouteFailure | undefined {
  const token = `${identity.type ?? ''} ${identity.code ?? ''}`.toLowerCase();
  if (token.trim() === '') return undefined;
  if (/rate.?limit/.test(token)) return { state: 'rate_limited', scope: 'pool', faultKind: 'rate_limited' };
  if (/quota|insufficient_quota|billing|payment/.test(token)) return { state: 'quota_exhausted', scope: 'pool', faultKind: 'quota_exhausted' };
  if (/authentication|permission|unauthorized|forbidden/.test(token)) return { state: 'auth_failed', scope: 'provider', faultKind: 'auth_failed' };
  if (/timeout|timed_out/.test(token)) return { state: 'model_unavailable', scope: 'route', faultKind: 'timeout' };
  if (/overload|server_error|internal_error|api_error|unavailable|bad_gateway/.test(token)) return { state: 'model_unavailable', scope: 'route', faultKind: 'server_error' };
  return undefined;
}
