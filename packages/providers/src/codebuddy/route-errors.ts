import type { UpstreamRouteErrorInput, UpstreamRouteFailure } from '../base/contracts.ts';
import { object, first, time } from '../base/quota-parsing.ts';
/** Only explicit exhaustion/model codes establish a route defect; no credit guesses. */
export function codeBuddyRouteFailure(input: UpstreamRouteErrorInput): UpstreamRouteFailure | undefined {
  const root = object(input.body);
  const error = object(root.error);
  const row = Object.keys(error).length ? error : root;
  const code = first(row, 'reason_code', 'code', 'type');
  const until = time(first(row, 'resets_at', 'reset_at', 'reset_time'));
  const quotaPoolId = first(row, 'quota_pool_id', 'quotaPoolId');
  if (code === 'quota_exhausted' || code === 'insufficient_quota') {
    return { state: 'quota_exhausted', scope: 'pool', ...(typeof quotaPoolId === 'string' ? { quotaPoolId } : {}), ...(until ? { until } : {}) };
  }
  if (code === 'insufficient_balance' || code === 'balance_exhausted') return { state: 'quota_exhausted', scope: 'provider', ...(until ? { until } : {}) };
  if (code === 'model_not_found' || code === 'model_unavailable') return { state: 'model_unavailable', scope: 'route', ...(until ? { until } : {}) };
  if (input.status === 429 && typeof quotaPoolId === 'string') return { state: 'rate_limited', scope: 'pool', quotaPoolId, ...(until ? { until } : {}) };
  return undefined;
}
