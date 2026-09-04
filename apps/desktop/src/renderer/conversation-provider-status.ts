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

/** Thin, read-only projection of the existing Desktop quota snapshot for the model picker. */
export function conversationProviderPresentation(
  providerId: string,
  snapshot?: QuotaSnapshot,
): ConversationProviderPresentation {
  const { catalog, quota } = quotaForProvider(snapshot, providerId);
  const label = catalog?.label || quota?.label || providerId;
  const details: string[] = [];

  if (quota?.balances.length) details.push('余额 / 按量');
  if (quota?.windows.length) details.push('额度计划');

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

  const red = exhausted || quota?.status === 'error' || quota?.status === 'unavailable';
  const yellow = low || paceLow || quota?.status === 'pending' || Boolean(quota?.stale);
  const status: ConversationProviderStatus = red ? 'red' : yellow ? 'yellow' : 'green';
  const statusLabel = status === 'red' ? '不可用' : status === 'yellow' ? '需要注意' : '状态正常';
  const message = quota?.message?.trim();
  if (message) details.push(message.slice(0, 160));
  return {
    id: providerId,
    label,
    status,
    tooltip: [label, statusLabel, ...details].join(' · '),
  };
}
