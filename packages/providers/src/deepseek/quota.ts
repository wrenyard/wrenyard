import type { QuotaSource } from '../base/provider-quota.ts';
import type { Provider } from '../base/provider.ts';
import { binding, balancePool } from '../base/quota-helpers.ts';
import { object, observation } from '../base/quota-parsing.ts';
import type { QuotaSnapshot } from '../base/quota-snapshot.ts';

const DEEPSEEK_PARSER = 'packages/providers/src/deepseek/quota.ts';

export const quota = {
  read: async (source: QuotaSource) => normalizeDeepSeekQuota(await source.read()),
  bindings: [
    // Official deepseek pool: the official `deepseek` provider row carries a
    // mandatory monetary balance resource (`deepseek/balance`) for every model it
    // serves, including deepseek-flash. It deliberately inherits NO CodeBuddy or
    // TokenHub balance: a missing/stale/unknown amount keeps coverage incomplete
    // rather than fabricating a balance.
    binding('deepseek', 'deepseek-flash', [balancePool('deepseek/balance', DEEPSEEK_PARSER)]),
    binding('deepseek', 'deepseek-pro', [balancePool('deepseek/balance', DEEPSEEK_PARSER)]),
  ],
  defaultPools: [balancePool('deepseek/balance', DEEPSEEK_PARSER)],
} satisfies Provider['quota'];

function normalizeDeepSeekQuota(raw: unknown): QuotaSnapshot {
    const { data, source, fetched_at } = observation(raw), root = object(data);
    if (root.is_available !== true || !Array.isArray(root.balance_infos) || !root.balance_infos.length)
        throw new Error('Balance unavailable');
    const balances = root.balance_infos.map(value => {
        const row = object(value), currency = String(row.currency ?? '').trim().toUpperCase();
        const amount = typeof row.total_balance === 'string' ? row.total_balance.trim() : '';
        if (!/^[A-Z]{3}$/.test(currency) || !/^\d+(?:\.\d+)?$/.test(amount))
            throw new Error('Invalid monetary balance');
        return { currency, amount };
    });
    return { provider: 'deepseek', status: 'ok', stale: false, source, fetched_at, balances };
}
