import type {
  ProviderCatalogSnapshot,
  QuotaProviderSnapshot,
  QuotaSnapshot,
} from '../shell-contract.js';

const LOW_REMAINING_PERCENT = 10;

export type ConversationProviderIndicatorKind =
  | 'balance'
  | 'quota-plan'
  | 'pace-low'
  | 'quota-low'
  | 'quota-empty'
  | 'pending'
  | 'error'
  | 'unavailable'
  | 'stale';

export interface ConversationProviderIndicator {
  kind: ConversationProviderIndicatorKind;
  label: string;
}

export interface ConversationProviderPresentation {
  id: string;
  label: string;
  indicators: ConversationProviderIndicator[];
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
  const indicators: ConversationProviderIndicator[] = [];

  if (quota?.balances.length) indicators.push({ kind: 'balance', label: '余额 / 按量' });
  if (quota?.windows.length) indicators.push({ kind: 'quota-plan', label: '额度计划' });

  if (quota?.status === 'pending') indicators.push({ kind: 'pending', label: '额度状态读取中' });
  if (quota?.status === 'error') indicators.push({ kind: 'error', label: '额度状态异常' });
  if (quota?.status === 'unavailable') indicators.push({ kind: 'unavailable', label: '额度状态不可用' });
  if (quota?.stale) indicators.push({ kind: 'stale', label: '额度状态可能已过期' });

  const remaining = quota?.windows.map((window) => window.remainingPct) ?? [];
  if (remaining.some((value) => value <= 0) || quota?.balances.some((balance) => balanceIsEmpty(balance.amount))) {
    indicators.push({ kind: 'quota-empty', label: '额度已耗尽' });
  } else if (remaining.some((value) => value <= LOW_REMAINING_PERCENT)) {
    indicators.push({ kind: 'quota-low', label: '剩余额度偏低' });
  }
  if (quota?.windows.some((window) => window.expectedRemainingPct !== null
    && window.remainingPct < window.expectedRemainingPct)) {
    indicators.push({ kind: 'pace-low', label: '消耗速度偏快' });
  }

  if (!quota && snapshot?.status === 'unavailable') {
    indicators.push({ kind: 'unavailable', label: 'Provider 状态不可用' });
  }

  const details = indicators.map((indicator) => indicator.label);
  const message = quota?.message?.trim();
  if (message) details.push(message.slice(0, 160));
  return {
    id: providerId,
    label,
    indicators,
    tooltip: [label, ...details].join(' · '),
  };
}
