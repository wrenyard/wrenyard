import type { QuotaProviderState, QuotaTipLine, QuotaBarRow, QuotaWindowRow } from '../shared/entities';

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
      const remainWindows = bar?.provider.windows ?? [];
      displayText = remainWindows.length > 0
        ? formatRemainQuotaLine(p.id, remainWindows, p.displayLine)
        : normalizeDisplayLine(p);
    }

    const entry: QuotaTipLine = { text: displayText };
    if (bar) entry.bars = [bar];
    if (errorRow) entry.errorRow = errorRow;
    tips.push(entry);
  }

  return tips;
}

function roundRemainPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(100, Math.max(0, n)));
}

export interface QuotaMenuRow {
  provider: string;
  window: string;
  remainingPct: number | null;
  expectedRemainingPct: number | null;
  error?: string;
  label: string;
}

/**
 * Tray 额度 submenu rows: same four columns as house tips
 * (`provider | window | remaining bar | integer % remain`).
 * Provider id only on the first window of a group. Error rows skip the bar.
 */
export function formatQuotaBarMenuRows(tips: QuotaTipLine[]): QuotaMenuRow[] {
  const rows: QuotaMenuRow[] = [];
  for (const tip of tips) {
    if (tip.errorRow) {
      rows.push({
        provider: tip.errorRow.label,
        window: '',
        remainingPct: null,
        expectedRemainingPct: null,
        error: tip.errorRow.message,
        label: `${tip.errorRow.label}  ${tip.errorRow.message}`,
      });
      continue;
    }
    const bar = tip.bars?.[0];
    const windows = bar?.provider.windows ?? [];
    if (!bar || windows.length === 0) {
      if (tip.text.trim()) {
        rows.push({
          provider: bar?.label ?? '',
          window: '',
          remainingPct: null,
          expectedRemainingPct: null,
          error: tip.text,
          label: tip.text,
        });
      }
      continue;
    }
    windows.forEach((window, index) => {
      const remain = roundRemainPct(window.remainingPct);
      const provider = index === 0 ? bar.label : '';
      rows.push({
        provider,
        window: window.name,
        remainingPct: remain,
        expectedRemainingPct: window.expectedRemainingPct,
        label: `${provider || bar.label} ${window.name} ${remain}% remain`,
      });
    });
  }
  return rows;
}

/**
 * House tips / tray lines show remaining quota. Pace and reset stay
 * Forge-owned and are copied from display_line when present.
 */
export function formatRemainQuotaLine(
  id: string,
  windows: QuotaWindowRow[],
  displayLine: string | null,
): string {
  const src = displayLine ?? '';
  const pace = src.match(/\(([+-]\d+%)\)/)?.[0];
  const reset = src.match(/·\s*([^·]*\breset)\s*$/)?.[1]?.trim();
  const has7d = windows.some((window) => window.name.toLowerCase() === '7d');
  const parts = windows.map((window, index) => {
    let part = `${window.name} ${roundRemainPct(window.remainingPct)}% remain`;
    const isAnchor = has7d ? window.name.toLowerCase() === '7d' : index === windows.length - 1;
    if (isAnchor && pace) part += ` ${pace}`;
    return part;
  });
  if (reset) parts.push(reset);
  return `${id} ${parts.join(' · ')}`;
}

function normalizeDisplayLine(p: QuotaProviderState): string {
  if (p.displayLine == null || p.displayLine === undefined) {
    return p.error ? `${p.id}: error — ${truncateMessage(p.error, 80)}` : `${p.id}: unavailable`;
  }
  let line: string;
  if (p.displayLine.startsWith(p.id)) {
    line = p.displayLine;
  } else if (p.displayLine.startsWith(p.label + ' ')) {
    line = p.id + p.displayLine.slice(p.label.length);
  } else {
    line = p.id + ' ' + p.displayLine;
  }
  if (/\bremain\b/.test(line) || /\bused\b/.test(line)) return line;
  return line.replace(/(\d+(?:\.\d+)?)%/g, '$1% remain');
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
