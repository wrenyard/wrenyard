import type { QuotaProviderState, QuotaProviderStatus, QuotaWindowRow } from '../../shell-contract.js';
import { findProviderQuotaPool, providerQuotaPoolLabel } from '@wrenyard/providers';
import { floorQuotaPercentage } from '../../pet/main/controller.js';

interface RawQuotaWindow {
  name?: string;
  pct?: number;
  used_pct?: number;
  remaining_pct?: number;
  expected_remaining_pct?: number;
  /** Provider wire window duration in minutes; drives the time-aware pace. */
  window_minutes?: number;
  /** Provider wire ISO reset time; drives the time-aware pace and reset label. */
  resets_at?: string;
}

interface RawQuotaEntry {
  provider?: string;
  label?: string;
  /** Explicit provider-reported account plan name; absent when unknown. */
  plan?: string;
  /** Verified login type the provider reported; absent when it reports none. */
  accountType?: string;
  /** Verified identity provider of that login; absent when it reports none. */
  idp?: string;
  status?: string;
  error?: string;
  code?: string;
  message?: string;
  display_line?: string;
  fetched_at?: string;
  stale?: boolean;
  /** Provider-level remaining/expected percentages */
  remaining_pct?: number;
  expected_remaining_pct?: number;
  /** Per-window rows */
  windows?: RawQuotaWindow[];
  /**
   * Provider-declared window names that do not apply to this account (e.g. the
   * ChatGPT Pro 5h window). They carry no percentage, so they stay out of the
   * structured bars and are restored in the subtitle as `<name> n/a` rather
   * than being silently dropped.
   */
  not_applicable_windows?: string[];
  /** Monetary balances from quota feature snapshots */
  balances?: Array<{
    currency?: unknown;
    amount?: unknown;
  }>;
  /** Daemon-computed estimated spend per quota window (Devin only). */
  estimatedSpend?: Array<{
    window?: unknown;
    models?: unknown;
    totalUsd?: unknown;
  }>;
}

function isFiniteZeroToOneHundred(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
}

/**
 * The declared pool label for one provider observation window, or undefined.
 * Resolved from shared provider metadata so the raw window name keeps driving
 * keys and pace while the display label prefers the pool's name.
 */
function poolLabelFor(providerId: string | undefined, windowName: string): string | undefined {
  if (typeof providerId !== 'string' || providerId.length === 0) return undefined;
  const pool = findProviderQuotaPool(providerId, windowName);
  return pool ? providerQuotaPoolLabel(pool) : undefined;
}

/**
 * Time-aware pace for one provider window: the remaining percentage implied by
 * the reset horizon (`resets_at - now`) over the window duration. This is the
 * same expected-remaining arithmetic the routing quota policy uses, and it is
 * the only source of the desktop pace marker after the wire dropped the
 * precomputed `expected_remaining_pct`. Returns null when the wire carries no
 * usable reset horizon, so no value is ever fabricated.
 */
function expectedRemainingFromWindow(w: RawQuotaWindow, nowMs: number): number | null {
  const minutes = w.window_minutes;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (typeof w.resets_at !== 'string') return null;
  const resetMs = Date.parse(w.resets_at);
  if (!Number.isFinite(resetMs)) return null;
  const horizonMs = resetMs - nowMs;
  const windowMs = minutes * 60_000;
  if (horizonMs <= 0 || horizonMs > windowMs) return null;
  return Math.round((horizonMs / windowMs) * 100 * 10) / 10;
}

function parseWindowBars(e: RawQuotaEntry, nowMs: number): QuotaProviderState['bars'] {
  let windows: QuotaWindowRow[] = [];

  if (Array.isArray(e.windows) && e.windows.length > 0) {
    windows = e.windows
      .filter((w): w is NonNullable<typeof e.windows>[number] & { name: string } =>
        typeof w === 'object' && w !== null && typeof w.name === 'string' && w.name.length > 0
      )
      .map((w) => {
        // Select usage from used_pct (preferred), then pct, then 0
        const usedPct = isFiniteZeroToOneHundred(w.used_pct) ? w.used_pct : (isFiniteZeroToOneHundred(w.pct) ? w.pct : 0);
        const remainingPct = isFiniteZeroToOneHundred(w.remaining_pct)
          ? w.remaining_pct
          : (isFiniteZeroToOneHundred(w.used_pct) ? Math.round((100 - w.used_pct) * 10) / 10
             : (isFiniteZeroToOneHundred(w.pct) ? Math.round((100 - w.pct) * 10) / 10 : 0));
        // An explicit wire value wins; otherwise derive the pace from the reset
        // horizon. No reset horizon leaves the marker absent rather than zero.
        const expectedRemainingPct = isFiniteZeroToOneHundred(w.expected_remaining_pct)
          ? w.expected_remaining_pct
          : expectedRemainingFromWindow(w, nowMs);
        // Carry the raw reset horizon and window length so the desktop
        // projection can pass structured countdown/label data to the renderer.
        const resetsAt = typeof w.resets_at === 'string' && Number.isFinite(Date.parse(w.resets_at))
          ? w.resets_at
          : undefined;
        const windowMinutes = typeof w.window_minutes === 'number'
          && Number.isFinite(w.window_minutes) && w.window_minutes > 0
          ? w.window_minutes
          : undefined;
        const poolLabel = poolLabelFor(e.provider, w.name);
        return {
          name: w.name,
          usedPct,
          remainingPct,
          expectedRemainingPct,
          ...(poolLabel !== undefined ? { poolLabel } : {}),
          ...(resetsAt ? { resetsAt } : {}),
          ...(windowMinutes !== undefined ? { windowMinutes } : {}),
        };
      });
    // All windows filtered out but original array had entries => invalid
    if (windows.length === 0 && Array.isArray(e.windows) && e.windows.length > 0) return undefined;
  }

  // Provider-level remaining/expected (used when windows are empty or alongside windows)
  const remainingPct = isFiniteZeroToOneHundred(e.remaining_pct) ? e.remaining_pct : null;
  const expectedRemainingPct = isFiniteZeroToOneHundred(e.expected_remaining_pct) ? e.expected_remaining_pct : null;

  // Return bars if we have windows or provider-level data
  if (windows.length > 0 || remainingPct !== null) {
    return { remainingPct, expectedRemainingPct, windows };
  }
  return undefined;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Validate a non-negative decimal-string amount (e.g. `"12.50"`).
 * Rejects missing, non-string, empty, negative, and non-numeric values.
 */
function isValidDecimalString(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0) return false;
  if (!/^\d+(\.\d+)?$/.test(v)) return false;
  return true;
}

/**
 * Format a monetary amount for a currency: CNY/UZS use the CNY prefix form
 * (¥/₩ style symbol), other ISO currencies use a symbol + amount form where
 * a common symbol exists, falling back to `AMOUNT CURRENCY`.
 */
function formatBalanceAmount(currency: string, amount: string): string {
  const symbol = currencySymbol(currency);
  if (symbol) return `${symbol}${amount}`;
  return `${amount} ${currency}`;
}

function currencySymbol(currency: string): string | null {
  switch (currency) {
    case 'CNY': return '¥';
    case 'USD': return '$';
    case 'EUR': return '€';
    case 'GBP': return '£';
    case 'JPY': return '¥';
    default: return null;
  }
}

/**
 * Parse the quota feature `balances` array defensively into structured monetary
 * rows distinct from percentage windows. Each row validates an uppercase
 * three-letter currency and a non-negative decimal-string amount. A malformed
 * array entry is dropped rather than becoming an ok zero balance; an entirely
 * malformed/non-array `balances` yields `undefined` (no balances).
 */
function parseBalances(e: RawQuotaEntry): QuotaProviderState['balances'] {
  if (!Array.isArray(e.balances) || e.balances.length === 0) return undefined;
  const rows: QuotaProviderState['balances'] = [];
  for (const b of e.balances) {
    if (!b || typeof b !== 'object') continue;
    const currency = b.currency;
    const amount = b.amount;
    if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) continue;
    if (!isValidDecimalString(amount)) continue;
    rows.push({
      currency,
      amount,
      display: formatBalanceAmount(currency, amount),
    });
  }
  return rows.length > 0 ? rows : undefined;
}

/**
 * Parse the daemon `estimatedSpend` array defensively into structured
 * per-window spend rows. Entries without a string window name, a finite
 * non-negative totalUsd, or a plain models record of finite non-negative
 * numbers are dropped; an entirely malformed value yields `undefined`.
 */
function parseEstimatedSpend(e: RawQuotaEntry): QuotaProviderState['estimatedSpend'] {
  if (!Array.isArray(e.estimatedSpend) || e.estimatedSpend.length === 0) return undefined;
  const rows: NonNullable<QuotaProviderState['estimatedSpend']> = [];
  for (const entry of e.estimatedSpend) {
    if (!entry || typeof entry !== 'object') continue;
    const window = entry.window;
    const totalUsd = entry.totalUsd;
    if (typeof window !== 'string' || window.length === 0) continue;
    if (typeof totalUsd !== 'number' || !Number.isFinite(totalUsd) || totalUsd < 0) continue;
    const models: Record<string, number> = {};
    if (entry.models !== null && typeof entry.models === 'object' && !Array.isArray(entry.models)) {
      for (const [model, usd] of Object.entries(entry.models as Record<string, unknown>)) {
        if (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0) models[model] = usd;
      }
    }
    rows.push({ window, models, totalUsd });
  }
  return rows.length > 0 ? rows : undefined;
}

/** Integer pace delta label (`(+N%)`/`(-N%)`) for the anchor window. */
function paceLabel(window: QuotaWindowRow): string | null {
  if (window.expectedRemainingPct === null) return null;
  const delta = Math.round(window.remainingPct - window.expectedRemainingPct);
  return `(${delta >= 0 ? '+' : ''}${delta}%)`;
}

/** Compact countdown (`16d 14h reset` / `2h 5m reset` / `9m reset`). */
function resetLabel(window: RawQuotaWindow | undefined, nowMs: number): string | null {
  if (!window || typeof window.resets_at !== 'string') return null;
  const resetMs = Date.parse(window.resets_at);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;
  const remaining = resetMs - nowMs;
  const days = Math.floor(remaining / 86_400_000);
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const text = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return `${text} reset`;
}

/**
 * Rebuild the provider subtitle the wire no longer carries (`display_line` was
 * retired) from the structured observation only: window names/remaining, the
 * anchor pace delta, the reset countdown and any provider-declared
 * non-applicable window (`<name> n/a`). Values come exclusively from wire
 * fields; a missing field is omitted rather than substituted.
 */
function synthesizeDisplayLine(
  id: string,
  rawWindows: RawQuotaWindow[] | undefined,
  notApplicableWindows: string[] | undefined,
  bars: QuotaProviderState['bars'],
  balances: QuotaProviderState['balances'],
  status: QuotaProviderStatus,
  nowMs: number,
): string | null {
  if (status !== 'ok') return null;
  const windows = bars?.windows ?? [];
  const rawByName = new Map<string, RawQuotaWindow>();
  for (const window of rawWindows ?? []) {
    if (typeof window?.name === 'string' && !rawByName.has(window.name)) rawByName.set(window.name, window);
  }
  // A window the provider marks non-applicable has no percentage to bar, so it
  // is preserved as an explicit `n/a` token instead of disappearing.
  const naParts: string[] = [];
  for (const name of Array.isArray(notApplicableWindows) ? notApplicableWindows : []) {
    if (typeof name !== 'string' || name.length === 0) continue;
    if (windows.some((window) => window.name === name)) continue;
    const part = `${name} n/a`;
    if (!naParts.includes(part)) naParts.push(part);
  }
  if (windows.length > 0) {
    let anchor = windows.findIndex((window) => window.name.toLowerCase() === '7d');
    if (anchor < 0) anchor = windows.length - 1;
    const parts = windows.map((window) => `${window.poolLabel ?? window.name} ${floorQuotaPercentage(window.remainingPct)}%`);
    const pace = paceLabel(windows[anchor]);
    if (pace) parts[anchor] += ` ${pace}`;
    // Prefer the anchor window's reset; fall back to the first window that
    // carries one so a reset countdown is never dropped for lack of an anchor.
    let reset = resetLabel(rawByName.get(windows[anchor].name), nowMs);
    if (!reset) {
      for (const window of windows) {
        reset = resetLabel(rawByName.get(window.name), nowMs);
        if (reset) break;
      }
    }
    parts.push(...naParts);
    if (reset) parts.push(reset);
    return `${id} ${parts.join(' · ')}`;
  }
  if (naParts.length > 0 || (balances && balances.length > 0)) {
    const parts = [
      ...naParts,
      ...(balances && balances.length > 0
        ? [`bal. ${balances.map((balance) => balance.display).join(' · ')}`]
        : []),
    ];
    return `${id} ${parts.join(' · ')}`;
  }
  return null;
}

export function parseQuotaJson(raw: string, now = Date.now()): QuotaProviderState[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new TypeError('quota feature output must be a JSON array');
  }

  const results: QuotaProviderState[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry || typeof entry !== 'object') continue;

    const e = entry as RawQuotaEntry;
    // Wire rows are provider-keyed; a missing provider id is malformed and
    // must be skipped rather than fabricated (no `pool-i` placeholder).
    if (typeof e.provider !== 'string' || e.provider.length === 0) continue;
    const id = e.provider;
    const label = typeof e.label === 'string' ? e.label : id;
    const rawDisplayLine = typeof e.display_line === 'string' && e.display_line.length > 0 ? e.display_line : null;
    // Provider message takes precedence over the error field; both are
    // preserved generically so pending/error rows can surface the message.
    const error =
      typeof e.message === 'string' && e.message.length > 0
        ? e.message
        : typeof e.error === 'string' && e.error.length > 0
          ? e.error
          : null;
    const stale = e.stale === true;

    // The plan is an explicit provider fact only. A blank/non-string value is
    // absent rather than a plan label inferred from message or quota amounts.
    const plan = typeof e.plan === 'string' && e.plan.trim().length > 0 ? e.plan.trim() : undefined;

    // Sanitized login identity the provider reported. Only these two strings
    // cross the boundary; no token, uid or enterprise id is ever read here.
    const accountType = typeof e.accountType === 'string' && e.accountType.trim().length > 0
      ? e.accountType.trim()
      : undefined;
    const idp = typeof e.idp === 'string' && e.idp.trim().length > 0 ? e.idp.trim() : undefined;

    // Passive provider code metadata (e.g. `authentication_pending`). Preserved
    // generically; status/message/error stay independent and code never
    // triggers provider-specific behavior.
    const code = typeof e.code === 'string' && e.code.length > 0 ? e.code : null;

    // Structured snapshots do not need the retired CLI display_line. A
    // successful plan/exhaustion message is informational, not a failure.
    const status = e.status === 'ok' || e.status === 'error'
      || e.status === 'pending' || e.status === 'unavailable'
      ? e.status
      : rawDisplayLine ? 'ok' : error ? 'error' : 'unavailable';

    const bars = parseWindowBars(e, now);
    const balances = parseBalances(e);
    const estimatedSpend = parseEstimatedSpend(e);
    // The wire retires `display_line`; rebuild the subtitle projection from the
    // structured window/balance rows so the Provider page and Pet tips keep the
    // previously displayed window, pace and reset details.
    const displayLine = rawDisplayLine ?? synthesizeDisplayLine(id, e.windows, e.not_applicable_windows, bars, balances, status, now);

    results.push({
      id,
      label,
      ...(plan !== undefined ? { plan } : {}),
      ...(accountType !== undefined ? { accountType } : {}),
      ...(idp !== undefined ? { idp } : {}),
      displayLine,
      error,
      status,
      stale,
      code,
      bars,
      balances,
      ...(estimatedSpend !== undefined ? { estimatedSpend } : {}),
    });
  }

  return results;
}
