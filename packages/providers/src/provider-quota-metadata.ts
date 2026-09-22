import { BUILTIN_PROVIDERS } from './catalog.js';
import { providerQuotas } from './builtins.ts';
import { binding } from './base/quota-helpers.ts';
import type { ProviderQuotaBinding, ProviderQuotaPool } from './base/quota.ts';
export type * from './base/quota.ts';

const explicitBindings = [...providerQuotas.values()].flatMap((quota) => quota.bindings);

/** Pools a provider owns. A provider without a quota source owns none. */
function defaultPoolsFor(providerId: string): readonly ProviderQuotaPool[] {
  return providerQuotas.get(providerId)?.defaultPools ?? [];
}

const catalogBindings = BUILTIN_PROVIDERS.flatMap((provider) => {
  const pools = defaultPoolsFor(provider.id);
  return provider.models.flatMap((model) => {
    const explicit = explicitBindings.find((entry) => entry.providerId === provider.id && entry.modelId === model.id);
    if (explicit) return [explicit];
    return pools.length ? [binding(provider.id, model.id, pools)] : [];
  });
});

/**
 * Provider-default bindings so a registered provider's model (including
 * discovered models not listed in the catalog) always resolves to at least one
 * own-provider pool. Never inherits another provider's resources. A provider
 * that owns no quota source contributes no binding, so lookups for it stay
 * undefined instead of claiming a pool it does not own.
 */
const providerDefaultBindings: ProviderQuotaBinding[] = BUILTIN_PROVIDERS.flatMap((provider) => {
  const pools = defaultPoolsFor(provider.id);
  return pools.length ? [binding(provider.id, '*', pools)] : [];
});

export const PROVIDER_QUOTA_BINDINGS: readonly ProviderQuotaBinding[] = Object.freeze([
  ...catalogBindings,
  ...explicitBindings.filter((entry) => !catalogBindings.some((item) => item.providerId === entry.providerId && item.modelId === entry.modelId)),
  ...providerDefaultBindings,
]);

/** The exact binding for one provider+model pair, or undefined. */
function exactBinding(providerId: string, modelId: string): ProviderQuotaBinding | undefined {
  return PROVIDER_QUOTA_BINDINGS.find(
    (entry) => entry.providerId === providerId && entry.modelId === modelId,
  );
}

/** The provider-default binding for a provider, or undefined. */
function defaultBinding(providerId: string): ProviderQuotaBinding | undefined {
  return providerDefaultBindings.find((entry) => entry.providerId === providerId);
}

/**
 * Returns the quota binding for a provider model, or undefined when the
 * provider is unknown or owns no quota source. A registered provider with a
 * quota source always gets a non-empty binding: an exact catalog binding when
 * one exists, otherwise that provider's own-default pool.
 */
export function findProviderQuotaBinding(
  providerId: string,
  modelId: string,
): ProviderQuotaBinding | undefined {
  return exactBinding(providerId, modelId) ?? defaultBinding(providerId);
}
