import type { QuotaSnapshot } from './quota-snapshot.ts';
export type QuotaWindow = NonNullable<QuotaSnapshot['windows']>[number];
export function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function number(value: unknown): number | undefined {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim()))
        return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}
export function first(row: Record<string, unknown>, ...keys: string[]): unknown {
    return keys.map(key => row[key]).find(value => value !== undefined && value !== null);
}
export function time(value: unknown): string | undefined {
    if (typeof value !== 'number' && typeof value !== 'string')
        return undefined;
    const numeric = number(value);
    const ms = numeric === undefined ? Date.parse(String(value)) : numeric > 1e11 ? numeric : numeric * 1000;
    if (!Number.isFinite(ms))
        return undefined;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
export function windowName(minutes: number): string {
    return minutes >= 1440 && minutes % 1440 === 0 ? minutes / 1440 + 'd' : minutes >= 60 && minutes % 60 === 0 ? minutes / 60 + 'h' : minutes + 'm';
}
export function observation(raw: unknown): {
    data: unknown;
    source: string;
    fetched_at: string;
} {
    const row = object(raw);
    if (typeof row.source !== 'string' || typeof row.fetched_at !== 'string' || !Number.isFinite(Date.parse(row.fetched_at)))
        throw new Error('Invalid observation');
    return { data: row.data, source: row.source, fetched_at: row.fetched_at };
}
export function snapshot(provider: string, raw: unknown, windows: readonly QuotaWindow[]): QuotaSnapshot {
    const { source, fetched_at } = observation(raw);
    if (!windows.length)
        throw new Error('No quota windows available');
    return { provider, status: 'ok', stale: false, source, fetched_at, windows };
}
