import { object, observation, number, time, type QuotaWindow } from '../base/quota-parsing.ts';
import type { QuotaSnapshot } from '../base/quota-snapshot.ts';
export function normalizeGrokQuota(raw: unknown): QuotaSnapshot {
    const { data, source, fetched_at } = observation(raw), config = object(object(data).config);
    let pct = number(config.creditUsagePercent);
    const used = number(object(config.used).val), limit = number(object(config.monthlyLimit).val);
    if (pct === undefined && used !== undefined && limit !== undefined && limit > 0)
        pct = used / limit * 100;
    const windows: QuotaWindow[] = [];
    if (pct !== undefined) {
        const period = object(config.currentPeriod), end = time(period.end ?? config.billingPeriodEnd), start = time(period.start ?? config.billingPeriodStart);
        const name = config.currentPeriod == null ? '1mo' : period.type === 'USAGE_PERIOD_TYPE_WEEKLY' ? '7d' : period.type === 'USAGE_PERIOD_TYPE_MONTHLY' ? '1mo' : 'quota';
        windows.push({ name, pct: Math.max(0, Math.min(100, pct)), window_minutes: start && end && Date.parse(end) > Date.parse(start) ? Math.trunc((Date.parse(end) - Date.parse(start)) / 60000) : 0, ...(end ? { resets_at: end } : {}) });
    }
    const cents = number(object(config.prepaidBalance).val);
    const balances = cents !== undefined && Number.isSafeInteger(cents) && cents >= 0 ? [{ currency: 'USD', amount: Math.floor(cents / 100) + '.' + String(cents % 100).padStart(2, '0') }] : [];
    // Preserve the existing quota row identity consumed by Desktop.
    return { provider: 'super-grok', status: 'ok', stale: false, source, fetched_at, windows, balances, ...(!windows.length && !balances.length ? { message: '当前账户未返回可展示的订阅额度。' } : {}) };
}
