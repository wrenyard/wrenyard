import type { ProviderDefinition } from '../base/index.ts';
import type { ProviderQuota, QuotaSnapshot } from '../base/index.ts';
import type { ProviderQuotaBinding, ProviderQuotaPool } from '../base/quota.ts';
import { object, observation, number } from '../base/quota-parsing.ts';
import { balancePool } from '../base/quota-helpers.ts';
import { productCreditsAreFree } from '../codebuddy/product.ts';
import type { WorkBuddyAccountIdentity, WorkBuddyAccountKind } from './credentials.ts';

const WORKBUDDY_CREDITS_UNIT = 'Points';
const WORKBUDDY_QUOTA_PARSER = 'packages/providers/src/workbuddy/quota.ts';

function creditsPool(providerId: string, usageUnknown = false): ProviderQuotaPool {
  return Object.freeze({
    ...balancePool(`${providerId}/credits`, WORKBUDDY_QUOTA_PARSER, '2026-10-27', usageUnknown),
    displayName: '积分',
  });
}

/** iOA exposes no reliable usage ratio: the same credits pool is pay-as-you-go with unknown usage. */
function ioaCreditsPool(providerId: string): ProviderQuotaPool {
  return creditsPool(providerId, true);
}

function poolForKind(providerId: string, accountKind: WorkBuddyAccountKind | undefined): ProviderQuotaPool {
  return accountKind === 'ioa' ? ioaCreditsPool(providerId) : creditsPool(providerId);
}

function workBuddyQuotaBindings(definition: ProviderDefinition, pool: ProviderQuotaPool): readonly ProviderQuotaBinding[] {
  return definition.models.map((model) => Object.freeze({
    providerId: definition.id,
    modelId: model.id,
    pools: Object.freeze(productCreditsAreFree(model.credits) ? [] : [pool]),
  }));
}

/** Model-agnostic WorkBuddy pool selector keyed by account kind so daemon
 * routing can rebind iOA's usage-unknown credits pool per live login. */
export function workBuddyPoolsForModel(
  providerId: string,
  _modelId: string,
  accountKind: WorkBuddyAccountKind | undefined,
): readonly ProviderQuotaPool[] {
  return Object.freeze([poolForKind(providerId, accountKind)]);
}

export function createWorkBuddyQuota(
  definition: ProviderDefinition,
  readObservation: () => Promise<unknown | undefined>,
  account?: () => WorkBuddyAccountIdentity | undefined,
): ProviderQuota {
  // The login type is read on every access: a WorkBuddy provider lives for the
  // whole process while its login can change, so the pool must be the one of
  // the CURRENT login type, never the one observed at construction.
  const pool = (): ProviderQuotaPool => poolForKind(definition.id, account?.()?.kind);
  return {
    get bindings() {
      return workBuddyQuotaBindings(definition, pool());
    },
    get defaultPools(): readonly ProviderQuotaPool[] {
      return Object.freeze([pool()]);
    },
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
      return normalizeWorkBuddyQuota(definition.id, observation(raw), account?.());
    },
  };
}

/** The verified login metadata a snapshot carries across the wire; both fields
 * stay absent when the login reports neither. */
function accountFields(identity: WorkBuddyAccountIdentity | undefined): Pick<QuotaSnapshot, 'accountType' | 'idp'> {
  return {
    ...(identity?.accountType === undefined ? {} : { accountType: identity.accountType }),
    ...(identity?.idp === undefined ? {} : { idp: identity.idp }),
  };
}

function normalizeWorkBuddyQuota(
  providerId: string,
  sample: ReturnType<typeof observation>,
  account?: WorkBuddyAccountIdentity,
): QuotaSnapshot | undefined {
  if (account?.kind === 'ioa') {
    // iOA exposes no authoritative usage ratio; never consume credit/limitNum.
    return {
      provider: providerId,
      status: 'ok',
      stale: false,
      source: sample.source,
      fetched_at: sample.fetched_at,
      windows: [],
      message: '按量计费 · 用量未知',
      ...accountFields(account),
    };
  }
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
    for (const item of groups) {
      const row = object(item);
      const total = number(row.CycleTotalCapacity);
      const remain = number(row.CycleRemainCapacity);
      if (total === undefined || total <= 0 || remain === undefined) continue;
      sumTotal += total;
      sumRemain += remain;
    }
    const plan = typeof root.SubscriptionPackageName === 'string' && root.SubscriptionPackageName.trim()
      ? root.SubscriptionPackageName.trim()
      : undefined;
    return {
      provider: providerId,
      status: 'ok',
      stale: false,
      source: sample.source,
      fetched_at: sample.fetched_at,
      windows: [],
      balances: [{ id: `${providerId}/credits`, unit: WORKBUDDY_CREDITS_UNIT, amount: String(sumRemain) }],
      ...(sumTotal > 0 ? { used: sumTotal - sumRemain, total: sumTotal } : {}),
      ...(plan ? { plan } : {}),
      ...accountFields(account),
    };
  }
  const enterprise = object(root);
  const credit = number(enterprise.credit);
  const limit = number(enterprise.limitNum);
  if (credit === undefined && limit === undefined) return undefined;
  const total = limit;
  const used = credit ?? 0;
  // credit is the consumed share of the limitNum grant, so the remain feeding
  // the balance row is limitNum - credit; a missing limit is reported-but-
  // unknown (null), never a fabricated zero.
  const amount = total !== undefined ? String(Math.max(0, total - used)) : null;
  return {
    provider: providerId,
    status: 'ok',
    stale: false,
    source: sample.source,
    fetched_at: sample.fetched_at,
    windows: [],
    balances: [{ id: `${providerId}/credits`, unit: WORKBUDDY_CREDITS_UNIT, amount }],
    ...(total !== undefined ? { used, total } : {}),
    ...accountFields(account),
  };
}
