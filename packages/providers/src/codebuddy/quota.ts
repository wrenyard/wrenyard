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

/** HY3 and HY4 Preview draw jointly on the family allowance. Offerings carry the
 * canonical registry ids, never the product-file wire spellings. */
function isHyFamilyModel(modelId: string): boolean {
  return modelId === 'hunyuan-hy3' || modelId === 'hunyuan-hy4-preview';
}

/**
 * Exact CodeBuddy quota applicability. HY models draw jointly on the family
 * allowance and the account monthly allowance; remaining models use monthly
 * only. IOA exposes no measured monthly usage, so its month observation is a
 * synthetic budget window derived from the current month's elapsed pace, and
 * the family allowance is excluded.
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
        // Synthetic estimate, not measured provider usage: assume the month is
        // consumed at 99% of the current elapsed-month pace.
        const elapsedMonthFraction = (now - start) / (end - start);
        return {
            provider: 'codebuddy', status: 'ok', stale: false,
            source: sample.source, fetched_at: sample.fetched_at,
            windows: [{ name: 'monthly', pct: exhausted ? 100 : 99 * elapsedMonthFraction,
                window_minutes: (end - start) / 60000,
                resets_at: exhausted ? reset : new Date(end).toISOString() }],
            message: exhausted
                ? 'CodeBuddy 本月额度已耗尽，重置后将自动恢复。'
                : '合成估算：1mo 已用按本月当前配速的 99% 估算，并非服务商实测额度。',
            not_applicable_windows: ['hy-family'],
        };
    }
    if (row.exhausted !== true || row.reason_code !== 'quota_exhausted' || !reset || Date.parse(reset) <= now)
        return undefined;
    return { provider: 'codebuddy', status: 'ok', stale: false, source: 'observed', windows: [{ name: 'observed', pct: 100, window_minutes: 0, resets_at: reset }], message: 'CodeBuddy 额度已耗尽，重置后将自动恢复。' };
}
