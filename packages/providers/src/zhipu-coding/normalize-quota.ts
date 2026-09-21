import { object, observation, number, first, snapshot, type QuotaWindow } from '../base/quota-parsing.ts';
function limits(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = limits(item);
            if (found.length)
                return found;
        }
        return [];
    }
    for (const [key, item] of Object.entries(object(value))) {
        if (key.toLowerCase() === 'limits' && Array.isArray(item))
            return item.map(object);
        const found = limits(item);
        if (found.length)
            return found;
    }
    return [];
}
export function normalizeZhipuQuota(raw: unknown, now = Date.now()) {
    const windows: QuotaWindow[] = [];
    for (const row of limits(observation(raw).data)) {
        if (String(row.name || row.type).toUpperCase() !== 'TOKENS_LIMIT')
            continue;
        const unit = number(row.unit), count = number(row.number), minutes = unit === 3 && count === 5 ? 300 : unit === 6 && count === 1 ? 10080 : 0;
        if (!minutes)
            continue;
        let pct = number(first(row, 'used_percent', 'usedPercent', 'usage_percent', 'usagePercent', 'percentage', 'percent', 'pct'));
        const used = number(first(row, 'used', 'usage')), total = number(first(row, 'total', 'limit'));
        if (pct === undefined && used !== undefined && total !== undefined && total > 0)
            pct = used / total * 100;
        if (pct === undefined)
            continue;
        const reset = number(row.nextResetTime), validReset = reset !== undefined && reset > now && reset <= now + minutes * 60000;
        windows.push({ name: minutes === 300 ? '5h' : '7d', pct, window_minutes: minutes, ...(validReset ? { resets_at: new Date(reset!).toISOString() } : {}) });
    }
    return snapshot('zhipu-coding', raw, windows);
}
