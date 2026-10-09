import type { ProviderDefinition, UpstreamRouteFailure } from '@wrenyard/providers/base';

const MAX_TIME_MS = 8.64e15;

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

function genericFailure(status: number, headers: Headers, nowMs: number): UpstreamRouteFailure | undefined {
  if (status === 429) {
    const reset = retryAfter(headers.get('retry-after'), nowMs) ?? rateLimitReset(headers.get('x-ratelimit-reset'), nowMs);
    return { state: 'rate_limited', scope: 'pool', ...(reset === undefined ? {} : { until: new Date(reset).toISOString() }) };
  }
  if (status === 402) return { state: 'quota_exhausted', scope: 'pool' };
  if (status === 401 || status === 403) return { state: 'auth_failed', scope: 'provider' };
  if (status === 404) return { state: 'model_unavailable', scope: 'route' };
  return undefined;
}

/**
 * Classify an upstream failure: generic status/header rules first, refined by
 * the supplier's own error-body rule (a narrower pool or an explicit reset).
 */
export function classifyRouteFailure(provider: ProviderDefinition, modelId: string, status: number, headers: Headers, body: unknown, nowMs: number): UpstreamRouteFailure | undefined {
  const generic = genericFailure(status, headers, nowMs);
  const specific = provider.classifyUpstreamError?.({ modelId, status, headers, body, nowMs });
  return specific ? { ...generic, ...specific } : generic;
}
