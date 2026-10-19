import { useSyncExternalStore } from 'react';
import { quotaPoolLevel, type QuotaLevel } from '@/renderer/components/usage/QuotaBar';
import type { QuotaProviderSnapshot, QuotaWindowSnapshot } from '@/shell-contract';
import { shell } from './desktop';

export interface QuotaWindowCandidate {
  provider: QuotaProviderSnapshot;
  window: QuotaWindowSnapshot;
  level: QuotaLevel;
}

const SEVERITY: Readonly<Record<QuotaLevel, number>> = { normal: 0, warning: 1, destructive: 2 };

/** Most severe window; ties go to the lowest remaining percentage. */
export function selectTightestQuotaWindow(
  providers: readonly QuotaProviderSnapshot[],
): QuotaWindowCandidate | null {
  let best: QuotaWindowCandidate | null = null;
  for (const provider of providers) {
    for (const window of provider.windows) {
      if (!Number.isFinite(window.remainingPct)) continue;
      const candidate: QuotaWindowCandidate = { provider, window, level: quotaPoolLevel(window) };
      if (best === null) {
        best = candidate;
        continue;
      }
      const severity = SEVERITY[candidate.level] - SEVERITY[best.level];
      if (severity > 0 || (severity === 0 && window.remainingPct < best.window.remainingPct)) best = candidate;
    }
  }
  return best;
}

let quotaFocus: string | null = null;
const quotaFocusListeners = new Set<() => void>();

export function setQuotaFocus(providerId: string | null, label?: string): void {
  if (quotaFocus !== providerId) {
    quotaFocus = providerId;
    for (const listener of quotaFocusListeners) listener();
  }
  if (providerId === null) {
    void shell.setQuotaFocus?.(null);
  } else {
    void shell.setQuotaFocus?.(label !== undefined ? { id: providerId, label } : { id: providerId });
  }
}

function subscribeQuotaFocus(listener: () => void): () => void {
  quotaFocusListeners.add(listener);
  return () => {
    quotaFocusListeners.delete(listener);
  };
}

function getQuotaFocusSnapshot(): string | null {
  return quotaFocus;
}

/** The quota provider of the model currently selected in the composer. */
export function useQuotaFocus(): string | null {
  return useSyncExternalStore(subscribeQuotaFocus, getQuotaFocusSnapshot, getQuotaFocusSnapshot);
}
