import type { QuotaSnapshot } from '../base/quota-snapshot.ts';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Interpret the Codex account response; this function performs no I/O. */
export function normalizeChatGPTQuota(raw: unknown, now = new Date()): QuotaSnapshot {
  const buckets = record(record(raw)?.rateLimitsByLimitId);
  const entry = record(buckets?.codex);
  if (!entry) throw new Error('chatgpt: codex rate-limit bucket is missing');
  const windows: NonNullable<QuotaSnapshot['windows']>[number][] = [];
  let unknownWindow = false;
  for (const value of [entry.primary, entry.secondary]) {
    if (value == null) continue;
    const window = record(value);
    const pct = window?.usedPercent;
    const minutes = window?.windowDurationMins;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || (minutes !== 300 && minutes !== 10080)) {
      unknownWindow = true;
      continue;
    }
    const reset = window?.resetsAt;
    const date = typeof reset === 'number' && reset > 0 ? new Date(Math.trunc(reset) * 1000) : undefined;
    windows.push({
      name: minutes === 300 ? '5h' : '7d',
      pct,
      window_minutes: minutes,
      ...(date && Number.isFinite(date.getTime()) ? { resets_at: date.toISOString() } : {}),
    });
  }
  if (windows.length === 0) throw new Error('chatgpt: no rate limit windows available');
  const plan = typeof entry.planType === 'string' ? entry.planType : '';
  const weeklyOnly = plan.toLowerCase() === 'pro' && !unknownWindow
    && windows.some(window => window.name === '7d') && !windows.some(window => window.name === '5h');
  return {
    provider: 'chatgpt', status: 'ok', stale: false,
    source: 'codex-app-server', fetched_at: now.toISOString(), windows,
    not_applicable_windows: weeklyOnly ? ['5h'] : [],
    ...(plan ? { message: 'plan: ' + plan } : {}),
  };
}
