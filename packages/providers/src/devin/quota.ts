import type { ProviderQuota, QuotaSnapshot } from '../base/index.ts';
import { number, object, observation, time } from '../base/quota-parsing.ts';

export const quota: ProviderQuota = {
  bindings: [], defaultPools: [],
  async read(source): Promise<QuotaSnapshot> {
    const raw = observation(await source.read());
    const root = object(raw.data);
    if (root.code) throw new Error('Devin quota query failed');
    const status = object(object(root.userStatus).planStatus), plan = object(status.planInfo);
    if (!Object.keys(status).length) throw new Error('Devin plan status is missing');
    const windows: NonNullable<QuotaSnapshot['windows']>[number][] = [];
    for (const [prefix, name, minutes] of [['daily', '1d', 1440], ['weekly', '7d', 10080]] as const) {
      if (plan[prefix === 'daily' ? 'hideDailyQuota' : 'hideWeeklyQuota'] === true) continue;
      const left = number(status[`${prefix}QuotaRemainingPercent`]);
      const reset = number(status[`${prefix}QuotaResetAtUnix`]);
      // Proto JSON omits zero; only quota billing plus a reset establishes exhaustion.
      if (left === undefined && !(plan.billingStrategy === 'BILLING_STRATEGY_QUOTA' && reset !== undefined && reset > 0)) continue;
      const resetsAt = reset !== undefined && reset > 0 ? time(reset) : undefined;
      windows.push({ name, pct: Math.max(0, Math.min(100, 100 - (left ?? 0))), window_minutes: minutes,
        ...(resetsAt ? { resets_at: resetsAt } : {}), });
    }
    const total = number(status.acuLimit), used = number(status.acuConsumed) ?? 0;
    const balance = number(status.overageBalanceMicros);
    return { provider: 'devin', status: 'ok', stale: false, source: raw.source, fetched_at: raw.fetched_at, windows,
      ...(total !== undefined && total > 0 ? { used, total } : {}),
      ...(balance !== undefined && balance >= 0 ? { balances: [{ currency: 'USD', amount: String(balance / 1e6) }] } : {}),
    };
  },
};
