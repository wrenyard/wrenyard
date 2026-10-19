import type { QuotaBarRow, QuotaProviderState, QuotaTipLine, QuotaWindowRow } from '../../shell-contract.js';
import { floorQuotaPercentage } from '../../pet/main/controller.js';

function truncateMessage(message: string, maxLength: number): string {
  if (message.length <= maxLength) return message;
  return message.slice(0, maxLength) + '…';
}

/**
 * Build passive house Tips in the Desktop-owned provider order. When `focus` is
 * given (the quota provider of the model selected in the composer) only that
 * provider is projected — even when it is not first in `order` — so every pool
 * of the selected provider stays visible. A focused provider missing from
 * `providers` is projected as an honest unknown line (error row plus a
 * status-bearing bar) instead of another provider's quota. Without `focus` the
 * order-based output is unchanged.
 */
export function buildQuotaTips(
  providers: QuotaProviderState[],
  order: string[],
  focus?: { id: string; label?: string },
): QuotaTipLine[] {
  const byId = new Map<string, QuotaProviderState>();
  for (const provider of providers) byId.set(provider.id, provider);

  const ids = focus ? [focus.id] : order;
  const tips: QuotaTipLine[] = [];
  for (const id of ids) {
    let provider = byId.get(id);
    if (!provider) {
      if (!focus) continue;
      // The focused provider is not in the incoming list; project it as an
      // unknown entry rather than silently dropping the focus or showing
      // another provider's quota.
      provider = {
        id: focus.id,
        label: focus.label ?? focus.id,
        displayLine: null,
        error: null,
        status: 'unavailable',
        stale: false,
      };
    }
    const nonOk = provider.status !== 'ok';

    let bar: QuotaBarRow | undefined;
    if (provider.bars) {
      const quota = { ...provider.bars };
      if (quota.windows.length === 0 && quota.remainingPct !== null) {
        quota.windows = [{
          name: 'quota',
          usedPct: 0,
          remainingPct: quota.remainingPct,
          expectedRemainingPct: quota.expectedRemainingPct,
        }];
      }
      bar = {
        provider: quota,
        label: provider.id,
        error: provider.error,
        status: provider.status,
        stale: provider.stale,
      };
    } else if (nonOk) {
      bar = {
        provider: { remainingPct: null, expectedRemainingPct: null, windows: [] },
        label: provider.id,
        error: provider.error,
        status: provider.status,
        stale: provider.stale,
      };
    }

    let displayText: string;
    let errorRow: { label: string; message: string } | undefined;
    if (nonOk) {
      const message = provider.status === 'error' && provider.error
        ? `error — ${truncateMessage(provider.error, 80)}`
        : provider.error ?? 'unavailable';
      errorRow = { label: provider.id, message };
      displayText = `${provider.id} ${message}`;
    } else {
      const remainWindows = bar?.provider.windows ?? [];
      displayText = remainWindows.length > 0
        ? formatRemainQuotaLine(provider.id, remainWindows, provider.displayLine)
        : normalizeDisplayLine(provider);
    }

    const entry: QuotaTipLine = { text: displayText };
    if (provider.plan !== undefined) entry.plan = provider.plan;
    if (bar) entry.bars = [bar];
    if (errorRow) entry.errorRow = errorRow;
    if (provider.balances && provider.balances.length > 0) {
      entry.balances = provider.balances;
      entry.balanceLabel = provider.id;
    }
    tips.push(entry);
  }
  return tips;
}

/** House Tips display remaining quota; pace/reset text stays Wrenyard-owned. */
export function formatRemainQuotaLine(
  id: string,
  windows: QuotaWindowRow[],
  displayLine: string | null,
): string {
  const source = displayLine ?? '';
  const pace = source.match(/\(([+-]\d+%)\)/)?.[0];
  const reset = source.match(/·\s*([^·]*\breset)\s*$/)?.[1]?.trim();
  const has7d = windows.some((window) => window.name.toLowerCase() === '7d');
  const parts = windows.map((window, index) => {
    let part = `${window.poolLabel ?? window.name} ${floorQuotaPercentage(window.remainingPct)}%`;
    const isAnchor = has7d ? window.name.toLowerCase() === '7d' : index === windows.length - 1;
    if (isAnchor && pace) part += ` ${pace}`;
    return part;
  });
  if (reset) parts.push(reset);
  return `${id} ${parts.join(' · ')}`;
}

function normalizeDisplayLine(provider: QuotaProviderState): string {
  if (provider.displayLine == null) {
    if (provider.status === 'ok') {
      const detail = provider.balances?.map(balance => balance.display).join(' · ')
        || provider.error || 'quota available';
      return `${provider.id} ${truncateMessage(detail, 80)}`;
    }
    return provider.error
      ? `${provider.id}: error — ${truncateMessage(provider.error, 80)}`
      : `${provider.id}: unavailable`;
  }
  let line: string;
  if (provider.displayLine.startsWith(provider.id)) {
    line = provider.displayLine;
  } else if (provider.displayLine.startsWith(provider.label + ' ')) {
    line = provider.id + provider.displayLine.slice(provider.label.length);
  } else {
    line = provider.id + ' ' + provider.displayLine;
  }
  return line.replace(/(\d+(?:\.\d+)?%)\s+remain\b/g, '$1');
}
