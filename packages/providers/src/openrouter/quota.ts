import type { QuotaSource } from '../base/provider-quota.ts';
import type { Provider } from '../base/provider.ts';
import { balancePool, quotaPool } from '../base/quota-helpers.ts';
import { object, observation } from '../base/quota-parsing.ts';
import type { QuotaSnapshot } from '../base/quota-snapshot.ts';

const OPENROUTER_PARSER = 'packages/providers/src/openrouter/quota.ts';

const OPENROUTER_FREE_POOL = quotaPool('openrouter/free', []);
const OPENROUTER_BALANCE_POOL = balancePool('openrouter/balance', OPENROUTER_PARSER);

export const quota = {
  read: async (source: QuotaSource) => normalizeOpenRouterQuota(await source.read()),
  bindings: [],
  pools: [OPENROUTER_BALANCE_POOL],
  defaultPools: [OPENROUTER_FREE_POOL],
} satisfies Provider['quota'];

function normalizeOpenRouterQuota(raw: unknown): QuotaSnapshot {
  const { data, source, fetched_at } = observation(raw);
  const root = object(object(data).data);
  const limitRemaining = root.limit_remaining;
  if (limitRemaining === null || limitRemaining === undefined) {
    throw new Error('No per-key spending cap');
  }
  if (typeof limitRemaining !== 'number' || !Number.isFinite(limitRemaining)) {
    throw new Error('Invalid key limit remaining');
  }
  const amount = Math.max(0, limitRemaining).toFixed(2);
  return {
    provider: 'openrouter',
    status: 'ok',
    stale: false,
    source,
    fetched_at,
    balances: [{ currency: 'USD', amount }],
  };
}
