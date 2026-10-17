import { BUILTIN_PROVIDERS } from './catalog.js';
import { providerQuotas } from './builtins.ts';
import { binding, freeQuotaPool } from './base/quota-helpers.ts';
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

/**
 * The synthesized free pool of one provider. Free models draw on this pool
 * alone, so exhausting a paid daily/weekly/monthly pool never makes a
 * confirmed-free model unavailable. It carries no windows: a windowless quota
 * pool contributes an unknown (never blocked) constraint.
 */
export function freePoolFor(providerId: string): ProviderQuotaPool {
  return freeQuotaPool(providerId);
}

export { freeQuotaPool };

/**
 * The binding selected by live supply evidence. Confirmed-free supply binds the
 * model to its provider's own free pool only; every other candidate keeps the
 * declared binding verbatim, including its paid default pools.
 */
export function findProviderQuotaBindingForSupply(
  providerId: string,
  modelId: string,
  confirmedFree: boolean,
): ProviderQuotaBinding | undefined {
  return confirmedFree
    ? binding(providerId, modelId, [freePoolFor(providerId)])
    : findProviderQuotaBinding(providerId, modelId);
}

/**
 * The declared pool that owns an observation window id for one provider, or
 * undefined. Pools are resolved by identity so the same pool reached through
 * several model bindings resolves once; an ambiguous match (two distinct pools
 * sharing the window id) or no match returns undefined rather than guessing.
 */
export function findProviderQuotaPool(
  providerId: string,
  windowId: string,
): ProviderQuotaPool | undefined {
  if (typeof providerId !== 'string' || typeof windowId !== 'string') return undefined;
  let match: ProviderQuotaPool | undefined;
  for (const entry of PROVIDER_QUOTA_BINDINGS) {
    if (entry.providerId !== providerId) continue;
    for (const pool of entry.pools) {
      if (!pool.windows.some((window) => window.windowId === windowId)) continue;
      if (match === undefined) {
        match = pool;
      } else if (match.quotaPoolId !== pool.quotaPoolId) {
        return undefined;
      }
    }
  }
  return match;
}

/**
 * The central pool label policy: the declared display name, else the pool id
 * with its leading provider segment removed (e.g. `chatgpt/5h` -> `5h`). An
 * already-unprefixed id is returned intact.
 */
export function providerQuotaPoolLabel(pool: ProviderQuotaPool): string {
  return pool.displayName ?? pool.quotaPoolId.slice(pool.quotaPoolId.indexOf('/') + 1);
}
