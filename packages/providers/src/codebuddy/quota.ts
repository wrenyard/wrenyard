import type { ProviderDefinition } from '../base/index.ts';

function quotaPool(quotaPoolId: string) {
  return Object.freeze({
    quotaPoolId,
    kind: 'quota' as const,
    windows: Object.freeze([]),
  });
}

function binding(providerId: string, modelId: string, pools: readonly ReturnType<typeof quotaPool>[]) {
  return Object.freeze({ providerId, modelId, pools: Object.freeze(pools.slice()) });
}

const HY_FAMILY_POOL = quotaPool('codebuddy/hy-family');
const MONTHLY_POOL = quotaPool('codebuddy/monthly');

function isHyFamilyModel(modelId: string): boolean {
  const canonical = modelId.endsWith('-ioa') ? modelId.slice(0, -4) : modelId;
  return canonical === 'hy3' || canonical === 'hy4-preview';
}

/**
 * Exact CodeBuddy quota applicability. HY models draw jointly on the family
 * allowance and the account monthly allowance; remaining models use monthly
 * only. No raw window evidence has been reviewed, so every pool stays empty.
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
