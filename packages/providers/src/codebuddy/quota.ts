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

const HY_FAMILY_POOL = quotaPool('codebuddy/hy-family');
const MONTHLY_POOL = { ...quotaPool('codebuddy/monthly'), displayName: '1mo' };
/** iOA exposes no monthly usage: the same monthly resource is pay-as-you-go with unknown usage. */
const IOA_MONTHLY_POOL = { ...MONTHLY_POOL, usageUnknown: true as const };

/** HY3 and HY4 Preview draw jointly on the family allowance. Offerings carry the
 * canonical registry ids, never the product-file wire spellings. */
function isHyFamilyModel(modelId: string): boolean {
  return modelId === 'hunyuan-hy3' || modelId === 'hunyuan-hy4-preview';
}

/**
 * Exact CodeBuddy quota applicability. HY models draw jointly on the family
 * allowance and the account monthly allowance; remaining models use monthly
 * only. iOA exposes no measured monthly usage, so there the monthly pool is
 * pay-as-you-go with usage unknown by design, and the family allowance is
 * excluded.
 */
export function codeBuddyQuotaBindings(definition: ProviderDefinition, environment?: string) {
  const monthly = environment === 'ioa' ? IOA_MONTHLY_POOL : MONTHLY_POOL;
  return definition.models.map((model) => (
    isHyFamilyModel(model.id)
      ? binding('codebuddy', model.id, [HY_FAMILY_POOL, monthly])
      : binding('codebuddy', model.id, [monthly])
  ));
}

/** Provider-default pools covering discovered CodeBuddy models not listed above. */
export function codeBuddyDefaultPools(environment?: string) {
  return [environment === 'ioa' ? IOA_MONTHLY_POOL : MONTHLY_POOL];
}

export function createCodeBuddyQuota(definition: ProviderDefinition, environment?: string): ProviderQuota {
    return { bindings: codeBuddyQuotaBindings(definition, environment), defaultPools: codeBuddyDefaultPools(environment),
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
            not_applicable_windows: ['hy-family'],
        };
    }
    if (row.exhausted !== true || row.reason_code !== 'quota_exhausted' || !reset || Date.parse(reset) <= now)
        return undefined;
    return { provider: 'codebuddy', status: 'ok', stale: false, source: 'observed', windows: [{ name: 'observed', pct: 100, window_minutes: 0, resets_at: reset }], message: 'CodeBuddy 额度已耗尽，重置后将自动恢复。' };
}
