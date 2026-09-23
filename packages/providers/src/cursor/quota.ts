import type { QuotaSource } from '../base/provider-quota.ts';
import type { Provider } from '../base/provider.ts';
import { binding, quotaWindow, quotaPool } from '../base/quota-helpers.ts';
import { object, observation, snapshot, time, type QuotaWindow } from '../base/quota-parsing.ts';

const CURSOR_PARSER = 'packages/providers/src/cursor/quota.ts';

const CURSOR_DOCS = 'https://cursor.com/docs/models-and-pricing';

const CURSOR_OTHER_POOL = quotaPool('cursor/other', [
  quotaWindow('Other', 'full_cycle', 'provider_parser', CURSOR_PARSER, '2026-09-10'),
]);

const CURSOR_POOL = quotaPool('cursor/cursor', [
  quotaWindow('Cursor', 'full_cycle', 'official_docs', CURSOR_DOCS),
]);

export const quota = {
  read: async (source: QuotaSource) => normalizeCursorQuota(await source.read()),
  bindings: [
    binding('cursor', 'grok-4.6', [CURSOR_POOL]),
    binding('cursor', 'grok-4.7', [CURSOR_POOL]),
    binding('cursor', 'composer-2.5', [CURSOR_POOL]),
    // Third-party Cursor models consume the Other allowance, not the Cursor pool.
    binding('cursor', 'kimi-k3', [CURSOR_OTHER_POOL]),
    binding('cursor', 'claude-opus-5-5', [CURSOR_OTHER_POOL]),
    binding('cursor', 'gpt-5.6-luna', [CURSOR_OTHER_POOL]),
    binding('cursor', 'gpt-5.6-sol', [CURSOR_OTHER_POOL]),
    binding('cursor', 'claude-sonnet-5', [CURSOR_OTHER_POOL]),
    binding('cursor', 'muse-spark-1.3', [CURSOR_OTHER_POOL]),
    binding('cursor', 'gemini-3.8-flash', [CURSOR_OTHER_POOL]),
    binding('cursor', 'claude-fable-5-1', [CURSOR_OTHER_POOL]),
  ],
  defaultPools: [quotaPool('cursor/usage', [])],
} satisfies Provider['quota'];

function normalizeCursorQuota(raw: unknown) {
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
