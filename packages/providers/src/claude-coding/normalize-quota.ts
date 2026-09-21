import { object, observation, number, first, time, windowName, snapshot, type QuotaWindow } from '../base/quota-parsing.ts';
function window(value: unknown, name: string, minutes: number): QuotaWindow | undefined {
    const row = object(value);
    let pct = number(first(row, 'usedPercent', 'used_percent', 'utilization', 'usage_percentage', 'percentage', 'pct'));
    const remaining = number(first(row, 'remainingPercent', 'remaining_percent', 'current_interval_remaining_percent'));
    if (pct === undefined && remaining !== undefined)
        pct = 100 - remaining;
    if (pct === undefined)
        return undefined;
    const duration = number(first(row, 'window_minutes', 'windowMinutes')) ?? minutes;
    const reset = time(first(row, 'reset_at', 'resets_at', 'resetsAt'));
    return { name, pct, window_minutes: duration, ...(reset ? { resets_at: reset } : {}) };
}
function oauth(data: unknown): QuotaWindow[] {
    const root = object(data), windows: QuotaWindow[] = [];
    for (const [prefix, name, minutes] of [['current_interval', '5h', 300], ['current_weekly', '7d', 10080]] as const) {
        const total = number(root[prefix + '_total_count']), used = number(root[prefix + '_usage_count']) ?? 0, remaining = number(root[prefix + '_remaining_percent']);
        const pct = total !== undefined && total > 0 ? used / total * 100 : remaining !== undefined ? 100 - remaining : undefined;
        if (pct === undefined)
            continue;
        const reset = time(first(root, prefix + '_reset_at', prefix + '_resets_at', 'reset_at', 'resets_at'));
        windows.push({ name, pct, window_minutes: number(first(root, prefix + '_window_minutes', prefix + '_windowMinutes', 'window_minutes', 'windowMinutes')) ?? minutes, ...(reset ? { resets_at: reset } : {}) });
    }
    if (!windows.length)
        for (const [key, name, minutes] of [['five_hour', '5h', 300], ['seven_day', '7d', 10080]] as const) {
            const w = window(root[key], name, minutes);
            if (w)
                windows.push(w);
        }
    return windows;
}
export function normalizeClaudeQuota(raw: unknown) {
    const observationData = observation(raw), data = object(observationData.data);
    if (observationData.source === 'claude-sources') {
        const source = object(data.snapshot), entry = Array.isArray(source.entries) ? object(source.entries.find(v => object(v).provider === 'claude')) : source;
        const windows: QuotaWindow[] = [];
        for (const value of [entry.primary, entry.secondary]) {
            const minutes = number(first(object(value), 'windowMinutes', 'window_minutes')) || 300;
            const w = window(value, windowName(minutes), minutes);
            if (w)
                windows.push(w);
        }
        if (windows.length && typeof data.snapshot_at === 'string')
            return snapshot('claude-coding', { source: 'codexbar-snapshot', fetched_at: data.snapshot_at }, windows);
        return snapshot('claude-coding', { source: 'oauth-api', fetched_at: data.oauth_at }, oauth(data.oauth));
    }
    return snapshot('claude-coding', raw, oauth(data));
}
