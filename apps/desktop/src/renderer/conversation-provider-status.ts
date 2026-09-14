import type {
  ProviderCatalogSnapshot,
  QuotaProviderSnapshot,
  QuotaSnapshot,
} from '../shell-contract.js';

const LOW_REMAINING_PERCENT = 10;

export type ConversationProviderStatus = 'green' | 'yellow' | 'red';

export interface ConversationProviderPresentation {
  id: string;
  label: string;
  status: ConversationProviderStatus;
  tooltip: string;
}

function quotaForProvider(
  snapshot: QuotaSnapshot | undefined,
  providerId: string,
): { catalog?: ProviderCatalogSnapshot; quota?: QuotaProviderSnapshot } {
  const catalog = snapshot?.catalog.find((entry) => entry.id === providerId);
  return {
    ...(catalog ? { catalog } : {}),
    ...(catalog?.quota
      ? { quota: catalog.quota }
      : snapshot?.providers.find((provider) => provider.id === providerId)
        ? { quota: snapshot.providers.find((provider) => provider.id === providerId) }
        : {}),
  };
}

function balanceIsEmpty(amount: string): boolean {
  const parsed = Number(amount);
  return Number.isFinite(parsed) && parsed <= 0;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '未知';
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}%`;
}

/** Thin, read-only projection of the existing Desktop quota snapshot for the model picker. */
export function conversationProviderPresentation(
  providerId: string,
  snapshot?: QuotaSnapshot,
): ConversationProviderPresentation {
  const { catalog, quota } = quotaForProvider(snapshot, providerId);
  const label = catalog?.label || quota?.label || providerId;
  const details: string[] = [];

  if (quota?.status === 'pending') details.push('额度状态读取中');
  if (quota?.status === 'error') details.push('额度状态异常');
  if (quota?.status === 'unavailable') details.push('额度状态不可用');
  if (quota?.stale) details.push('额度状态可能已过期');

  const remaining = quota?.windows.map((window) => window.remainingPct) ?? [];
  const exhausted = remaining.some((value) => value <= 0)
    || Boolean(quota?.balances.some((balance) => balanceIsEmpty(balance.amount)));
  const low = !exhausted && remaining.some((value) => value <= LOW_REMAINING_PERCENT);
  const paceLow = Boolean(quota?.windows.some((window) => window.expectedRemainingPct !== null
    && window.remainingPct < window.expectedRemainingPct));
  if (exhausted) details.push('额度已耗尽');
  else if (low) details.push('剩余额度偏低');
  if (paceLow) details.push('消耗速度偏快');

  // Actual per-window numbers from the snapshot, shown verbatim (no estimation).
  for (const window of quota?.windows ?? []) {
    details.push(`${window.name} 剩余 ${formatPercent(window.remainingPct)}`);
  }
  // Balance amounts in their own currency, exactly as the snapshot reports them.
  for (const balance of quota?.balances ?? []) {
    details.push(`余额 ${balance.display || `${balance.amount} ${balance.currency}`.trim()}`);
  }

  const red = exhausted || quota?.status === 'error' || quota?.status === 'unavailable';
  const yellow = !red && (low || paceLow || quota?.status === 'pending' || Boolean(quota?.stale));
  // Without concrete window/balance numbers the quota state is unknown;
  // unknown must never read as healthy (green / 状态正常).
  const hasNumbers = (quota?.windows.length ?? 0) > 0 || (quota?.balances.length ?? 0) > 0;
  const unknown = !red && !yellow && !hasNumbers;
  const status: ConversationProviderStatus = red ? 'red' : yellow || unknown ? 'yellow' : 'green';
  let statusLabel = '状态正常';
  if (red) statusLabel = '不可用';
  else if (unknown) statusLabel = '额度未知';
  else if (yellow) statusLabel = '需要注意';
  const message = quota?.message?.trim();
  if (message) details.push(message.slice(0, 160));
  return {
    id: providerId,
    label,
    status,
    tooltip: [label, statusLabel, ...details].join(' · '),
  };
}
