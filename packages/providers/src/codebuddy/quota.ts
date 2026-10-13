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
const MONTHLY_POOL = quotaPool('codebuddy/monthly');

/** HY3 and HY4 Preview draw jointly on the family allowance. Offerings carry the
 * canonical registry ids, never the product-file wire spellings. */
function isHyFamilyModel(modelId: string): boolean {
  return modelId === 'hunyuan-hy3' || modelId === 'hunyuan-hy4-preview';
}

/**
 * Exact CodeBuddy quota applicability. HY models draw jointly on the family
 * allowance and the account monthly allowance; remaining models use monthly
 * only. IOA reports the monthly window and excludes the family allowance.
 */
export function codeBuddyQuotaBindings(definition: ProviderDefinition) {
  return definition.models.map((model) => (
    isHyFamilyModel(model.id)
      ? binding('codebuddy', model.id, [HY_FAMILY_POOL, MONTHLY_POOL])
      : binding('codebuddy', model.id, [MONTHLY_POOL])
  ));
}

/** Provider-default pools covering discovered CodeBuddy models not listed above. */
export function codeBuddyDefaultPools() {
  return [MONTHLY_POOL];
}

export function createCodeBuddyQuota(definition: ProviderDefinition): ProviderQuota {
    return { bindings: codeBuddyQuotaBindings(definition), defaultPools: codeBuddyDefaultPools(),
      read: async source => normalizeCodeBuddyQuota(await source.read()) };
  }

/** The quota feature validates the active account scope before exposing this observation. */
function normalizeCodeBuddyQuota(raw: unknown, now = Date.now()): QuotaSnapshot | undefined {
    const sample = observation(raw);
    const row = object(sample.data), reset = time(row.resets_at);
    if (row.environment === 'ioa') {
        const offset = 8 * 60 * 60 * 1000;
        const date = new Date(now + offset);
        const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) - offset;
        const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - offset;
        const exhausted = row.exhausted === true && row.reason_code === 'quota_exhausted'
            && reset !== undefined && Date.parse(reset) > now;
        return {
            provider: 'codebuddy', status: 'ok', stale: false,
            source: sample.source, fetched_at: sample.fetched_at,
            windows: [{ name: 'monthly', pct: exhausted ? 100 : 0,
                window_minutes: (end - start) / 60000,
                resets_at: exhausted ? reset : new Date(end).toISOString() }],
            not_applicable_windows: ['hy-family'],
        };
    }
    if (row.exhausted !== true || row.reason_code !== 'quota_exhausted' || !reset || Date.parse(reset) <= now)
        return undefined;
    return { provider: 'codebuddy', status: 'ok', stale: false, source: 'observed', windows: [{ name: 'observed', pct: 100, window_minutes: 0, resets_at: reset }], message: 'CodeBuddy 额度已耗尽，重置后将自动恢复。' };
}
