import type { QuotaSource } from '../base/provider-quota.ts';
import type { Provider } from '../base/provider.ts';
import type { ProviderQuotaPool } from '../base/quota.ts';
import { quotaWindow, quotaPool, balancePool } from '../base/quota-helpers.ts';
import type { QuotaSnapshot } from '../base/quota-snapshot.ts';

const CODEX_PARSER = 'packages/providers/src/chatgpt/quota.ts';

/** Stable identity of the subscription Credits balance row and its pool. */
export const CHATGPT_CREDITS_BALANCE_ID = 'chatgpt/credits';
const CHATGPT_CREDITS_UNIT = 'Credits';

const CHATGPT_7D_POOL = quotaPool('chatgpt/7d', [
  quotaWindow('7d', 'full_cycle', 'provider_parser', CODEX_PARSER, '2026-09-09'),
], 0.2);

const CHATGPT_5H_POOL = quotaPool('chatgpt/5h', [
  quotaWindow('5h', 'full_cycle', 'provider_parser', CODEX_PARSER, '2026-09-09'),
], 0.2);

/**
 * The subscription Credits pay-as-you-go pool. It is an ALTERNATE funding
 * declaration only: it never joins `defaultPools`, so the static binding
 * keeps its conjunctive 5h+7d requirement and the daemon's effective-source
 * selection decides when it becomes the active pool.
 */
export const CHATGPT_CREDITS_POOL: ProviderQuotaPool = Object.freeze({
  ...balancePool(CHATGPT_CREDITS_BALANCE_ID, CODEX_PARSER, '2026-10-22'),
  displayName: 'Credits',
});

/** The declared ChatGPT subscription pools in their stable order. */
export const CHATGPT_SUBSCRIPTION_POOL_IDS = Object.freeze([
  CHATGPT_5H_POOL.quotaPoolId,
  CHATGPT_7D_POOL.quotaPoolId,
]);

export const quota = {
  read: async (source: QuotaSource) => normalizeChatGPTQuota(await source.read()),
  bindings: [],
  defaultPools: [CHATGPT_5H_POOL, CHATGPT_7D_POOL],
} satisfies Provider['quota'];

/**
 * The single ChatGPT subscription-first funding-source rule. Inputs are
 * already-assessed per-pool states (exhausted is a confirmed observation,
 * never stale/unknown), so every consumer applies the identical decision:
 *
 * - `subscription`: no applicable subscription window is confirmed exhausted —
 *   the subscription is preferred even while Credits are zero or absent.
 * - `credits`: an applicable subscription window is confirmed exhausted AND
 *   fresh Credits evidence is a positive balance or explicit unlimited.
 * - `exhausted`: subscription exhausted AND Credits confirmed empty.
 * - `unresolved`: subscription exhausted but Credits unknown — never asserted
 *   as zero or as paid eligibility.
 */
export type ChatGptFundingSource = 'subscription' | 'credits' | 'exhausted' | 'unresolved';

export function selectChatGptFundingSource(input: {
  /** True when at least one applicable subscription pool is confirmed exhausted. */
  readonly subscriptionExhausted: boolean;
  /** Fresh Credits capacity classification. */
  readonly credits: 'available' | 'empty' | 'unknown';
}): ChatGptFundingSource {
  if (!input.subscriptionExhausted) return 'subscription';
  switch (input.credits) {
    case 'available': return 'credits';
    case 'empty': return 'exhausted';
    default: return 'unresolved';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/**
 * Interpret the Codex `credits` block: `{ hasCredits, unlimited, balance }`.
 * The verbatim decimal string is preserved; `balance: null` stays unknown
 * (never fabricated zero), and an absent/malformed block yields no row at all.
 * A consistent `hasCredits: false` with a reported balance is still carried
 * verbatim — the funding rule treats missing balances as unknown, and a
 * positive reported amount keeps its own evidence.
 */
function creditsBalanceOf(entry: Record<string, unknown>): QuotaSnapshot['balances'] {
  const credits = record(entry.credits);
  if (credits === undefined) return undefined;
  const balance = credits.balance;
  const unlimited = credits.unlimited === true;
  const amount = typeof balance === 'string' && /^\d+(?:\.\d+)?$/.test(balance) ? balance : null;
  if (credits.hasCredits === false && amount === null && !unlimited) {
    // Consistent negative with no value: reported-but-unknown, not zero.
    return [{ id: CHATGPT_CREDITS_BALANCE_ID, unit: CHATGPT_CREDITS_UNIT, amount: null }];
  }
  return [{
    id: CHATGPT_CREDITS_BALANCE_ID,
    unit: CHATGPT_CREDITS_UNIT,
    amount,
    ...(unlimited ? { unlimited: true } : {}),
  }];
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
  const plan = typeof entry.planType === 'string' ? entry.planType.trim() : '';
  const weeklyOnly = plan.toLowerCase() === 'pro' && !unknownWindow
    && windows.some(window => window.name === '7d') && !windows.some(window => window.name === '5h');
  const balances = creditsBalanceOf(entry);
  return {
    provider: 'chatgpt', status: 'ok', stale: false,
    source: 'codex-app-server', fetched_at: now.toISOString(), windows,
    not_applicable_windows: weeklyOnly ? ['5h'] : [],
    ...(balances === undefined ? {} : { balances }),
    ...(plan ? { plan } : {}),
  };
}
