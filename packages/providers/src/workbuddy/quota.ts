import type { ProviderDefinition } from '../base/index.ts';
import type { ProviderQuota, QuotaSnapshot } from '../base/index.ts';
import { object, observation, number } from '../base/quota-parsing.ts';
import { quotaPool, quotaWindow } from '../base/quota-helpers.ts';

const MONTHLY_POOL = quotaPool('workbuddy/monthly', [
  quotaWindow('monthly', 'full_cycle', 'provider_parser', 'packages/providers/src/workbuddy/quota.ts'),
]);

export function createWorkBuddyQuota(definition: ProviderDefinition): ProviderQuota {
  return {
    bindings: definition.models.map((model) => Object.freeze({
      providerId: definition.id,
      modelId: model.id,
      pools: Object.freeze([MONTHLY_POOL]),
    })),
    defaultPools: [MONTHLY_POOL],
    async read(source): Promise<QuotaSnapshot | undefined> {
      return normalizeWorkBuddyQuota(definition.id, observation(await source.read()));
    },
  };
}

function normalizeWorkBuddyQuota(providerId: string, sample: ReturnType<typeof observation>): QuotaSnapshot | undefined {
  const envelope = object(sample.data);
  const root = object(envelope.data ?? envelope);
  const packages = Array.isArray(root.Packages) ? root.Packages : [];
  if (packages.length > 0) {
    const windows: NonNullable<QuotaSnapshot['windows']>[number][] = [];
    for (const item of packages) {
      const row = object(item);
      const code = typeof row.PackageCode === 'string' ? row.PackageCode : 'package';
      const total = number(row.CycleTotalCapacity);
      const used = number(row.CycleUsedCapacity);
      const remain = number(row.CycleRemainCapacity);
      if (total === undefined && used === undefined && remain === undefined) continue;
      const resolvedTotal = total ?? (used !== undefined && remain !== undefined ? used + remain : undefined);
      const resolvedUsed = used ?? (resolvedTotal !== undefined && remain !== undefined ? resolvedTotal - remain : undefined);
      if (resolvedTotal === undefined || resolvedTotal <= 0 || resolvedUsed === undefined) continue;
      const pct = Math.max(0, Math.min(100, (resolvedUsed / resolvedTotal) * 100));
      windows.push({ name: code, pct, window_minutes: 0 });
    }
    const plan = root.IsPaidUser === true ? 'Pro' : root.IsPaidUser === false ? 'Free' : undefined;
    return {
      provider: providerId,
      status: 'ok',
      stale: false,
      source: sample.source,
      fetched_at: sample.fetched_at,
      windows,
      ...(plan ? { message: plan } : {}),
    };
  }
  const enterprise = object(root);
  const credit = number(enterprise.credit);
  const limit = number(enterprise.limitNum);
  if (credit === undefined && limit === undefined) return undefined;
  const used = credit ?? 0;
  const total = limit;
  const windows = total !== undefined && total > 0
    ? [{ name: 'cycle', pct: Math.max(0, Math.min(100, (used / total) * 100)), window_minutes: 0 }]
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
