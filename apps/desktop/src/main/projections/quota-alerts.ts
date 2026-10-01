// ── Quota threshold alert projection ─────────────────────────────────
// Downward threshold crossings are computed in the main process so a window
// in the background still emits a system notification (usage spec 6.6). This
// module owns only the threshold/once-per-cycle bookkeeping: the caller feeds
// every quota snapshot into `observe`, and each crossing is handed to the
// injected `notify` sink (the notification center), which applies the
// `notifications.events.quotaWarning` preference gate.

import type { QuotaSnapshot } from '../../shell-contract.js';
import type { NotificationInput } from '../notification-center.js';
import { QuotaAlertTracker } from './quota-service.js';

export interface QuotaAlertsDeps {
  /** Sink for a threshold crossing; typically the notification center push. */
  notify(input: NotificationInput): void;
}

export interface QuotaAlerts {
  observe(snapshot: QuotaSnapshot): void;
}

export function createQuotaAlerts(deps: QuotaAlertsDeps): QuotaAlerts {
  const tracker = new QuotaAlertTracker();

  function observe(snapshot: QuotaSnapshot): void {
    // Tracking consumes every sample even while the quota-warning event is off;
    // only emission is gated by the notification center. Skipping observation
    // would let a crossing that happened while notifications were disabled
    // replay as a fresh alert when the event is switched back on. Eligible
    // providers match the status-bar QuotaItem projection: when an explicit
    // order exists, only order-enabled configured providers are tracked.
    const enabledIds = new Set(
      snapshot.providerOrder.filter((entry) => entry.enabled).map((entry) => entry.id),
    );
    const eligible = snapshot.providerOrder.length === 0
      ? snapshot.providers
      : snapshot.providers.filter((provider) => enabledIds.has(provider.id));
    const providers = eligible.map((provider) => ({
      id: provider.id,
      label: provider.label,
      windows: provider.windows.map((window) => ({ name: window.name, remainingPct: window.remainingPct })),
    }));
    const alerts = tracker.observe(providers);
    for (const alert of alerts) {
      deps.notify({
        id: alert.id,
        level: alert.level,
        source: 'quota',
        title: alert.title,
        description: alert.description,
        action: { label: '查看额度', command: { id: 'quota.showPanel' } },
      });
    }
  }

  return { observe };
}
