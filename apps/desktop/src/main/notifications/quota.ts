// Quota producer: downward remaining-percentage crossings at 30/10/5/0, plus a pace alert when remaining trails expected by QUOTA_PACE_WARN_DELTA.

import {
  QUOTA_PACE_WARN_DELTA,
  eligibleQuotaProviders,
  type QuotaProviderSnapshot,
  type QuotaSnapshot,
  type QuotaWindowSnapshot,
} from '../../shell-contract.js';
import type { AppNotification, NotificationLevel, Notifier } from './notifier.js';

/** The downward crossing thresholds, from warning to exhaustion. */
const QUOTA_THRESHOLDS = [30, 10, 5, 0] as const;
type QuotaThreshold = (typeof QUOTA_THRESHOLDS)[number];

interface WindowTracking {
  readonly armed: Set<number>;
  /** True while the pace alert is armed (waiting for the gap to open). */
  paceArmed: boolean;
}

export interface QuotaNotifier {
  observe(snapshot: QuotaSnapshot): void;
}

export interface QuotaNotifierDeps {
  notifier: Notifier;
}

function thresholdLevel(threshold: QuotaThreshold): NotificationLevel {
  return threshold === 0 ? 'error' : 'warning';
}

function quotaThresholdNotification(
  provider: QuotaProviderSnapshot,
  window: QuotaWindowSnapshot,
  threshold: QuotaThreshold,
  remainingPct: number,
  stamp: number,
): AppNotification {
  const providerLabel = provider.label || provider.id;
  return {
    id: `quota:${provider.id}:${window.name}:${threshold}:${stamp}`,
    level: thresholdLevel(threshold),
    title: threshold === 30 ? '额度告警' : '额度不足',
    body: `${providerLabel} ${window.name} 剩余 ${Math.floor(remainingPct)}%`,
    action: { label: '查看额度', command: { id: 'quota.showPanel' } },
  };
}

function quotaPaceNotification(
  provider: QuotaProviderSnapshot,
  window: QuotaWindowSnapshot,
  remainingPct: number,
  stamp: number,
): AppNotification {
  const providerLabel = provider.label || provider.id;
  return {
    id: `quota:${provider.id}:${window.name}:pace:${stamp}`,
    level: 'warning',
    title: '剩余额度超出配速',
    body: `${providerLabel} ${window.name} 剩余 ${Math.floor(remainingPct)}%`,
    action: { label: '查看额度', command: { id: 'quota.showPanel' } },
  };
}

export function createQuotaNotifier(deps: QuotaNotifierDeps): QuotaNotifier {
  const tracking = new Map<string, WindowTracking>();
  let sequence = 0;

  function observe(snapshot: QuotaSnapshot): void {
    const eligible = eligibleQuotaProviders(snapshot);

    for (const provider of eligible) {
      for (const window of provider.windows) {
        if (typeof window.name !== 'string' || window.name.length === 0) continue;
        const remaining = Number.isFinite(window.remainingPct) ? window.remainingPct : 0;
        const expected = window.expectedRemainingPct;
        const key = `${provider.id}\u0000${window.name}`;
        const existing = tracking.get(key);
        if (existing === undefined) {
          const armed = new Set<number>();
          for (const threshold of QUOTA_THRESHOLDS) if (remaining > threshold) armed.add(threshold);
          // Seed the pace state without alerting: armed only when the gap is
          // currently closed, so an already-open gap must close first.
          const paceArmed = expected !== null && Number.isFinite(expected)
            ? remaining >= expected - QUOTA_PACE_WARN_DELTA
            : false;
          tracking.set(key, { armed, paceArmed });
          continue;
        }
        for (const threshold of QUOTA_THRESHOLDS) {
          if (existing.armed.has(threshold)) {
            if (remaining <= threshold) {
              existing.armed.delete(threshold);
              sequence += 1;
              deps.notifier.notify(quotaThresholdNotification(provider, window, threshold, remaining, sequence), ['inApp']);
            }
          } else if (remaining > threshold) {
            existing.armed.add(threshold);
          }
        }
        if (expected !== null && Number.isFinite(expected)) {
          const gapOpen = remaining < expected - QUOTA_PACE_WARN_DELTA;
          if (existing.paceArmed && gapOpen) {
            existing.paceArmed = false;
            sequence += 1;
            deps.notifier.notify(quotaPaceNotification(provider, window, remaining, sequence), ['inApp']);
          } else if (!existing.paceArmed && !gapOpen) {
            existing.paceArmed = true;
          }
        }
      }
    }
  }

  return { observe };
}
