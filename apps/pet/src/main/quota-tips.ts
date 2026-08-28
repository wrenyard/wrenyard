import type { QuotaProviderState, QuotaTipLine, QuotaBarRow, QuotaWindowRow } from '../shared/entities';
import { floorQuotaPercentage } from '../shared/quota-percentage';

function truncateMessage(message: string, maxLength: number): string {
  if (message.length <= maxLength) return message;
  return message.slice(0, maxLength) + '…';
}

/** Build passive house Tips in the Desktop-owned provider order. */
export function buildQuotaTips(providers: QuotaProviderState[], order: string[]): QuotaTipLine[] {
  const byId = new Map<string, QuotaProviderState>();
  for (const provider of providers) byId.set(provider.id, provider);

  const tips: QuotaTipLine[] = [];
  for (const id of order) {
    const provider = byId.get(id);
    if (!provider) continue;
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

/** House Tips display remaining quota; pace/reset text stays Forge-owned. */
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
    let part = `${window.name} ${floorQuotaPercentage(window.remainingPct)}%`;
    const isAnchor = has7d ? window.name.toLowerCase() === '7d' : index === windows.length - 1;
    if (isAnchor && pace) part += ` ${pace}`;
    return part;
  });
  if (reset) parts.push(reset);
  return `${id} ${parts.join(' · ')}`;
}

function normalizeDisplayLine(provider: QuotaProviderState): string {
  if (provider.displayLine == null) {
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
