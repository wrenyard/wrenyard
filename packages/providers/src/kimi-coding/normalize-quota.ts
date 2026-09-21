import { object, observation, number, first, time, windowName, snapshot, type QuotaWindow } from '../base/quota-parsing.ts';
function detail(value: unknown) {
    const row = object(value), total = number(first(row, 'limit', 'total'));
    if (total === undefined || total <= 0)
        return undefined;
    let used = number(first(row, 'used', 'usage'));
    const remaining = number(row.remaining);
    if (used === undefined && remaining !== undefined)
        used = total - remaining;
    if (used === undefined)
        return undefined;
    return { used: Math.max(0, used), total, reset: time(first(row, 'resetTime', 'reset_time', 'resetsAt', 'resets_at')) };
}
function window(value: unknown, fallback: number, monthly = false): QuotaWindow | undefined {
    const row = object(value), usage = detail(row.detail ?? row);
    if (!usage)
        return undefined;
    const spec = object(row.window), duration = number(spec.duration), unit = String(spec.timeUnit ?? '').toUpperCase();
    const factor = ['TIME_UNIT_HOUR', 'HOUR', 'HOURS'].includes(unit) ? 60 : ['TIME_UNIT_DAY', 'DAY', 'DAYS'].includes(unit) ? 1440 : 1;
    const minutes = duration !== undefined && duration > 0 ? Math.trunc(duration * factor) : fallback;
    return { name: monthly ? '1mo' : windowName(minutes), pct: usage.used / usage.total * 100, window_minutes: minutes, ...(usage.reset ? { resets_at: usage.reset } : {}) };
}
export function normalizeKimiQuota(raw: unknown) {
    const root = object(observation(raw).data);
    const nested = Array.isArray(root.usages) ? root.usages.map(object).find(row => !row.scope || String(row.scope).toUpperCase() === 'FEATURE_CODING') : undefined;
    const usage = detail(root.usage ?? nested?.detail), limits = root.usage != null ? root.limits : nested?.limits;
    const windows: QuotaWindow[] = [];
    if (Array.isArray(limits))
        for (const item of limits) {
            const w = window(item, 300);
            if (w)
                windows.push(w);
        }
    if (usage)
        windows.push({ name: '7d', pct: usage.used / usage.total * 100, window_minutes: 10080, ...(usage.reset ? { resets_at: usage.reset } : {}) });
    const monthly = window(root.totalQuota ?? nested?.totalQuota, 43200, true);
    if (monthly)
        windows.push(monthly);
    return { ...snapshot('kimi-coding', raw, windows), ...(usage ? { used: usage.used, total: usage.total } : {}) };
}
