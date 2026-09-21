import { object, observation } from '../base/quota-parsing.ts';
import type { QuotaSnapshot } from '../base/quota-snapshot.ts';
export function normalizeDeepSeekQuota(raw: unknown): QuotaSnapshot {
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
