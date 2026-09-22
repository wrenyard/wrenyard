import type { QuotaSource } from '../base/provider-quota.ts';
import type { Provider } from '../base/provider.ts';
import { quotaWindow, quotaPool } from '../base/quota-helpers.ts';
import type { QuotaSnapshot } from '../base/quota-snapshot.ts';

const CODEX_PARSER = 'packages/providers/src/chatgpt/quota.ts';

const CHATGPT_7D_POOL = quotaPool('chatgpt/7d', [
  quotaWindow('7d', 'full_cycle', 'provider_parser', CODEX_PARSER, '2026-09-09'),
]);

const CHATGPT_5H_POOL = quotaPool('chatgpt/5h', [
  quotaWindow('5h', 'full_cycle', 'provider_parser', CODEX_PARSER, '2026-09-09'),
]);

export const quota = {
  read: async (source: QuotaSource) => normalizeChatGPTQuota(await source.read()),
  bindings: [],
  defaultPools: [CHATGPT_5H_POOL, CHATGPT_7D_POOL],
} satisfies Provider['quota'];


function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Interpret the Codex account response; this function performs no I/O. */
function normalizeChatGPTQuota(raw: unknown, now = new Date()): QuotaSnapshot {
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
