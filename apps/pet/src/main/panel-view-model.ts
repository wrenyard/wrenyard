import type { QuotaProviderState, QuotaTipLine, QuotaBarRow } from '../shared/entities';

export interface StatsSummaryLine {
  text: string;
}

function truncateMessage(msg: string, maxLen: number): string {
  if (msg.length <= maxLen) return msg;
  return msg.slice(0, maxLen) + '…';
}

/**
 * Build quota tip lines preserving settings order.
 * All enabled providers are included (not only ok/displayLine),
 * and structured bar data is projected from the provider bars field.
 */
export function buildQuotaTips(providers: QuotaProviderState[], order: string[]): QuotaTipLine[] {
  const byId = new Map<string, QuotaProviderState>();
  for (const p of providers) {
    byId.set(p.id, p);
  }

  const tips: QuotaTipLine[] = [];
  for (const id of order) {
    const p = byId.get(id);
    if (!p) continue;

    const nonOk = p.status !== 'ok';

    // Build bar data from provider bars if available
    let bar: QuotaBarRow | undefined;
    if (p.bars) {
      const provider = { ...p.bars };
      if (provider.windows.length === 0 && provider.remainingPct !== null) {
        provider.windows = [{
          name: 'quota',
          usedPct: 0,
          remainingPct: provider.remainingPct,
          expectedRemainingPct: provider.expectedRemainingPct,
        }];
      }
      bar = {
        provider,
        label: p.id,
        error: p.error,
        status: p.status,
        stale: p.stale,
      };
    } else if (nonOk) {
      // Error/unavailable without bars: inject empty structured row for alignment
      bar = {
        provider: { remainingPct: null, expectedRemainingPct: null, windows: [] },
        label: p.id,
        error: p.error,
        status: p.status,
        stale: p.stale,
      };
    }

    // Build display text and optional errorRow. Non-ok rows are provider-agnostic:
    // surface the Forge-provided message/error first, then a generic unavailable
    // fallback. Pending status is accepted without provider-specific branching.
    let displayText: string;
    let errorRow: { label: string; message: string } | undefined;
    if (nonOk) {
      const message = p.status === 'error' && p.error
        ? `error — ${truncateMessage(p.error, 80)}`
        : p.error
          ? p.error
          : 'unavailable';
      errorRow = { label: p.id, message };
      displayText = `${p.id} ${message}`;
    } else {
      if (p.displayLine !== null && p.displayLine !== undefined) {
        // Normalize displayText prefix from family label to provider id
        if (p.displayLine.startsWith(p.id)) {
          displayText = p.displayLine;
        } else if (p.displayLine.startsWith(p.label + ' ')) {
          displayText = p.id + p.displayLine.slice(p.label.length);
        } else {
          displayText = p.id + ' ' + p.displayLine;
        }
      } else {
        displayText = p.error ? `${p.id}: error — ${truncateMessage(p.error, 80)}` : `${p.id}: unavailable`;
      }
    }

    const entry: QuotaTipLine = { text: displayText };
    if (bar) entry.bars = [bar];
    if (errorRow) entry.errorRow = errorRow;
    tips.push(entry);
  }

  return tips;
}

/**
 * Build the first tips line showing dispatch count and token totals.
 * e.g. "7 dispatch · 1.5k tok (1.2k/340)"
 */
export function buildDispatchAndTokenLine(
  dispatchCount: number,
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
): StatsSummaryLine {
  const compact = compactNumber(totalTokens);
  const inputCompact = compactNumber(inputTokens);
  const outputCompact = compactNumber(outputTokens);
  return {
    text: `${dispatchCount} dispatch · ${compact} tok (${inputCompact}/${outputCompact})`,
  };
}

/**
 * Build a success rate line. denominator 0 displays em dash.
 */
export function buildSuccessRateLine(successCount: number, totalCount: number): StatsSummaryLine {
  if (totalCount === 0) {
    return { text: 'success rate: —' };
  }
  const pct = ((successCount / totalCount) * 100).toFixed(1);
  return { text: `success rate: ${pct}%` };
}

/**
 * Select and order quota providers for the Stats panel, preserving settings order.
 * Unlike buildQuotaTips (which only includes ok/displayLine), this retains
 * error/unavailable providers so the Stats panel can render status rows.
 */
export function selectStatsProviders(providers: QuotaProviderState[], order: string[]): QuotaProviderState[] {
  const byId = new Map<string, QuotaProviderState>();
  for (const p of providers) {
    byId.set(p.id, p);
  }

  const selected: QuotaProviderState[] = [];
  for (const id of order) {
    const p = byId.get(id);
    if (!p) continue;
    selected.push(p);
  }

  return selected;
}

export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
}
