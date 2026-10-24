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
 *   the parser's flag-derived availability is `available` (`unlimited` or
 *   `hasCredits` true).
 * - `exhausted`: subscription exhausted AND Credits confirmed empty.
 * - `unresolved`: subscription exhausted but Credits unknown — never asserted
 *   as zero or as paid eligibility.
 */
export type ChatGptFundingSource = 'subscription' | 'credits' | 'exhausted' | 'unresolved';

/**
 * The normalized ChatGPT Credits availability carried on the balance row and
 * consumed identically by routing and display: derived exclusively from the
 * upstream `unlimited`/`hasCredits` flags, never from the numeric balance.
 */
export type ChatGptCreditsAvailability = 'available' | 'unavailable' | 'unknown';

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

/** Only a JSON boolean is a valid upstream flag; anything else is unknown. */
function strictBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * Upstream `rateLimitReachedType` values that hard-stop Credits funding. The
 * generic literal `rate_limit_reached` is NOT a hard stop and never changes
 * availability.
 */
const CREDITS_HARD_STOP_TYPES: ReadonlySet<string> = new Set([
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]);

/**
 * Interpret the Codex `credits` block: `{ hasCredits, unlimited, balance }`.
 * A snapshot is well-formed only when BOTH `hasCredits` and `unlimited` are
 * real JSON booleans; any missing/null/non-boolean flag yields 'unknown' —
 * the row is then never an effective `unlimited` and its amount is display
 * only. Availability is `(unlimited || hasCredits) ? 'available' :
 * 'unavailable'`; a malformed flag is never OR-ed into truthiness.
 * Hard-stop signals sit on the same entry (siblings of `credits`):
 * `spendControlReached === true` or a workspace credits/usage-limit
 * `rateLimitReachedType` forces 'unavailable' regardless of the flags.
 * The verbatim signed decimal string is preserved for display: `balance`
 * absent/null/non-numeric stays null (unknown, never zero) and a negative
 * amount keeps its sign. An absent/malformed block yields no row at all.
 */
function creditsBalanceOf(entry: Record<string, unknown>): QuotaSnapshot['balances'] {
  const credits = record(entry.credits);
  if (credits === undefined) return undefined;
  const hasCredits = strictBool(credits.hasCredits);
  const unlimited = strictBool(credits.unlimited);
  const balance = credits.balance;
  const amount = typeof balance === 'string' && balance.length > 0
    && /^[+-]?\d+(?:\.\d+)?$/.test(balance) ? balance : null;
  const hardStop = entry.spendControlReached === true
    || (typeof entry.rateLimitReachedType === 'string' && CREDITS_HARD_STOP_TYPES.has(entry.rateLimitReachedType));
  const availability: ChatGptCreditsAvailability =
    hardStop ? 'unavailable'
    : hasCredits === null || unlimited === null ? 'unknown'
    : (unlimited || hasCredits) ? 'available'
    : 'unavailable';
  return [{
    id: CHATGPT_CREDITS_BALANCE_ID,
    unit: CHATGPT_CREDITS_UNIT,
    amount,
    availability,
    ...(availability === 'available' && unlimited === true ? { unlimited: true } : {}),
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
  const weeklyOnly = ['pro', 'prolite'].includes(plan.toLowerCase()) && !unknownWindow
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
