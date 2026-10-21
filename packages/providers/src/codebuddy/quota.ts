import type { ProviderQuota } from '../base/provider-quota.ts';
import type { ProviderDefinition } from '../base/index.ts';
import { object, observation, time } from '../base/quota-parsing.ts';
import type { QuotaSnapshot } from '../base/quota-snapshot.ts';
import { quotaWindow } from '../base/quota-helpers.ts';

function quotaPool(quotaPoolId: string) {
  return Object.freeze({
    quotaPoolId,
    kind: 'quota' as const,
    windows: Object.freeze([quotaWindow(quotaPoolId.split('/')[1], 'full_cycle', 'provider_parser', 'packages/providers/src/codebuddy/quota.ts', '2026-10-13')]),
    routingDiscountRate: 1,
  });
}

function binding(providerId: string, modelId: string, pools: readonly ReturnType<typeof quotaPool>[]) {
  return Object.freeze({ providerId, modelId, pools: Object.freeze(pools.slice()) });
}

const HY3_POOL = { ...quotaPool('codebuddy/hy3'), displayName: 'HY3' };
const HY4_PREVIEW_POOL = { ...quotaPool('codebuddy/hy4-preview'), displayName: 'HY4 Preview' };
const MONTHLY_POOL = { ...quotaPool('codebuddy/monthly'), displayName: '1mo' };
/** iOA exposes no monthly usage: the same monthly resource is pay-as-you-go with unknown usage. */
const IOA_MONTHLY_POOL = { ...MONTHLY_POOL, usageUnknown: true as const };

/** Upstream counts HY3 and HY4 Preview separately, so each keeps its own pool:
 * a rate limit or exhaustion on one must never poison the other. Offerings carry
 * the canonical registry ids, never the product-file wire spellings. */
function hyPoolForModel(modelId: string) {
  if (modelId === 'hunyuan-hy3') return HY3_POOL;
  if (modelId === 'hunyuan-hy4-preview') return HY4_PREVIEW_POOL;
  return undefined;
}

/**
 * Exact CodeBuddy quota applicability. HY3 and HY4 Preview each draw on their
 * own per-model allowance plus the account monthly allowance; remaining models
 * use monthly only. iOA exposes no measured monthly usage, so there the monthly
 * pool is pay-as-you-go with usage unknown by design, and the per-model
 * allowances are excluded.
 */
export function codeBuddyQuotaBindings(definition: ProviderDefinition, environment?: string) {
  const monthly = environment === 'ioa' ? IOA_MONTHLY_POOL : MONTHLY_POOL;
  return definition.models.map((model) => {
    const pool = hyPoolForModel(model.id);
    return pool
      ? binding('codebuddy', model.id, [pool, monthly])
      : binding('codebuddy', model.id, [monthly]);
  });
}

/** Provider-default pools covering discovered CodeBuddy models not listed above. */
export function codeBuddyDefaultPools(environment?: string) {
  return [environment === 'ioa' ? IOA_MONTHLY_POOL : MONTHLY_POOL];
}

/** Model-agnostic CodeBuddy pool selector keyed by environment for the daemon
 * routing snapshot: exact bindings stay the catalog identity, this returns the
 * pool list one model id draws on. */
export function codeBuddyPoolsForModel(modelId: string, environment?: string) {
  const monthly = environment === 'ioa' ? IOA_MONTHLY_POOL : MONTHLY_POOL;
  const pool = hyPoolForModel(modelId);
  return Object.freeze(pool ? [pool, monthly] : [monthly]);
}

export function createCodeBuddyQuota(definition: ProviderDefinition): ProviderQuota {
    return { get bindings() { return codeBuddyQuotaBindings(definition); }, defaultPools: codeBuddyDefaultPools(),
      read: async source => normalizeCodeBuddyQuota(await source.read()) };
  }

/** The quota feature validates the active account scope before exposing this observation. */
function normalizeCodeBuddyQuota(raw: unknown, now = Date.now()): QuotaSnapshot | undefined {
    const sample = observation(raw);
    const row = object(sample.data), reset = time(row.resets_at);
    if (row.environment === 'ioa') {
        const exhausted = row.exhausted === true && row.reason_code === 'quota_exhausted'
            && reset !== undefined && Date.parse(reset) > now;
        return {
            provider: 'codebuddy', status: 'ok', stale: false,
            source: sample.source, fetched_at: sample.fetched_at,
            windows: exhausted ? [{ name: 'monthly', pct: 100, window_minutes: 0, resets_at: reset }] : [],
            message: exhausted
                ? 'CodeBuddy 本月额度已耗尽，重置后将自动恢复。'
                : '按量计费 · 用量未知',
            not_applicable_windows: ['hy3', 'hy4-preview'],
        };
    }
    if (row.exhausted !== true || row.reason_code !== 'quota_exhausted' || !reset || Date.parse(reset) <= now)
        return undefined;
    return { provider: 'codebuddy', status: 'ok', stale: false, source: 'observed', windows: [{ name: 'observed', pct: 100, window_minutes: 0, resets_at: reset }], message: 'CodeBuddy 额度已耗尽，重置后将自动恢复。' };
}
