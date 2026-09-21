import { object, observation, snapshot, time, type QuotaWindow } from '../base/quota-parsing.ts';
export function normalizeCursorQuota(raw: unknown) {
    const root = object(observation(raw).data), usage = object(root.planUsage);
    const reset = time(root.billingCycleEnd);
    const entries = usage.autoPercentUsed != null || usage.apiPercentUsed != null
        ? [['Cursor', usage.autoPercentUsed], ['Other', usage.apiPercentUsed]] as const
        : [['Total', usage.totalPercentUsed]] as const;
    const windows: QuotaWindow[] = [];
    for (const [name, pct] of entries)
        if (typeof pct === 'number' && Number.isFinite(pct))
            windows.push({ name, pct: Math.max(0, Math.min(100, pct)), window_minutes: 43200, ...(reset ? { resets_at: reset } : {}) });
    return snapshot('cursor', raw, windows);
}
