import type { ProviderDefinition } from '../base/index.ts';
import type { ProviderQuota, QuotaSnapshot } from '../base/index.ts';
import type { ProviderQuotaBinding, ProviderQuotaPool } from '../base/quota.ts';
import { object, observation, number } from '../base/quota-parsing.ts';
import { quotaPool, quotaWindow } from '../base/quota-helpers.ts';
import { productCreditsAreFree } from '../codebuddy/product.ts';

function creditsPool(providerId: string): ProviderQuotaPool {
  return quotaPool(`${providerId}/credits`, [
    quotaWindow('credits', 'unproven', 'provider_parser', 'packages/providers/src/workbuddy/quota.ts'),
  ], 1, '积分');
}

function workBuddyQuotaBindings(definition: ProviderDefinition, pool: ProviderQuotaPool): readonly ProviderQuotaBinding[] {
  return definition.models.map((model) => Object.freeze({
    providerId: definition.id,
    modelId: model.id,
    pools: Object.freeze(productCreditsAreFree(model.credits) ? [] : [pool]),
  }));
}

export function createWorkBuddyQuota(
  definition: ProviderDefinition,
  readObservation: () => Promise<unknown | undefined>,
): ProviderQuota {
  const pool = creditsPool(definition.id);
  return {
    get bindings() {
      return workBuddyQuotaBindings(definition, pool);
    },
    defaultPools: [pool],
    async read(): Promise<QuotaSnapshot | undefined> {
      // The quota catch classifies a ClientError as configuration_missing so the
      // provider does not appear activated; providers cannot import
      // @wrenyard/clients, so return the same snapshot shape instead.
      const raw = await readObservation();
      if (raw === undefined) {
        return {
          provider: definition.id,
          status: 'error',
          stale: false,
          code: 'configuration_missing',
          error: 'Provider quota unavailable',
        };
      }
      return normalizeWorkBuddyQuota(definition.id, observation(raw));
    },
  };
}

function normalizeWorkBuddyQuota(providerId: string, sample: ReturnType<typeof observation>): QuotaSnapshot | undefined {
  const envelope = object(sample.data);
  const root = object(envelope.data ?? envelope);
  const groups = Array.isArray(root.CreditGroups)
    ? root.CreditGroups
    : Array.isArray(root.Packages)
      ? root.Packages
      : [];
  if (groups.length > 0 || Array.isArray(root.CreditGroups)) {
    let sumTotal = 0;
    let sumRemain = 0;
    const windows: NonNullable<QuotaSnapshot['windows']>[number][] = [];
    for (const item of groups) {
      const row = object(item);
      const total = number(row.CycleTotalCapacity);
      const remain = number(row.CycleRemainCapacity);
      if (total === undefined || total <= 0 || remain === undefined) continue;
      sumTotal += total;
      sumRemain += remain;
      const name = typeof row.Name === 'string' && row.Name.trim()
        ? row.Name.trim()
        : typeof row.PackageCode === 'string'
          ? row.PackageCode
          : 'group';
      const pct = Math.max(0, Math.min(100, ((total - remain) / total) * 100));
      windows.push({ name, pct, window_minutes: 0 });
    }
    const plan = typeof root.SubscriptionPackageName === 'string' && root.SubscriptionPackageName.trim()
      ? root.SubscriptionPackageName.trim()
      : undefined;
    if (sumTotal > 0) {
      const usedCredits = sumTotal - sumRemain;
      const creditsPct = Math.max(0, Math.min(100, (usedCredits / sumTotal) * 100));
      return {
        provider: providerId,
        status: 'ok',
        stale: false,
        source: sample.source,
        fetched_at: sample.fetched_at,
        windows: [{ name: 'credits', pct: creditsPct, window_minutes: 0 }, ...windows],
        used: usedCredits,
        total: sumTotal,
        ...(plan ? { plan } : {}),
      };
    }
    return {
      provider: providerId,
      status: 'ok',
      stale: false,
      source: sample.source,
      fetched_at: sample.fetched_at,
      windows,
      ...(plan ? { plan } : {}),
    };
  }
  const enterprise = object(root);
  const credit = number(enterprise.credit);
  const limit = number(enterprise.limitNum);
  if (credit === undefined && limit === undefined) return undefined;
  const total = limit;
  const used = credit ?? 0;
  const windows = total !== undefined && total > 0
    ? [{ name: 'credits', pct: Math.max(0, Math.min(100, (used / total) * 100)), window_minutes: 0 }]
    : [];
  return {
    provider: providerId,
    status: 'ok',
    stale: false,
    source: sample.source,
    fetched_at: sample.fetched_at,
    windows,
    ...(total !== undefined ? { used, total } : {}),
  };
}
