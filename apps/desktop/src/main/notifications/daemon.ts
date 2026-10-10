// Daemon producer (in-app + system): notify a disconnect after running, and a reconnect only after a notified disconnect. The first snapshot seeds state and does not notify.

import type { AppNotification, Notifier } from './notifier.js';
import type { DaemonLifecycleSnapshot, DaemonProcessState } from '../../shell-contract.js';

export interface DaemonNotifier {
  observe(snapshot: DaemonLifecycleSnapshot): void;
}

export interface DaemonNotifierDeps {
  notifier: Notifier;
}

export function createDaemonNotifier(deps: DaemonNotifierDeps): DaemonNotifier {
  let lastState: DaemonProcessState | undefined;
  let disconnectNotified = false;
  let sequence = 0;

  return {
    observe(snapshot: DaemonLifecycleSnapshot): void {
      const state = snapshot.state;
      if (lastState === undefined) {
        // Startup states never notify; seed the baseline.
        lastState = state;
        return;
      }
      const previous = lastState;
      lastState = state;

      if (previous === 'running' && state !== 'running') {
        sequence += 1;
        const notification: AppNotification = {
          id: `daemon:${sequence}`,
          level: 'warning',
          title: 'Daemon 连接已断开',
          ...(snapshot.message !== undefined ? { body: snapshot.message } : {}),
        };
        disconnectNotified = true;
        deps.notifier.notify(notification, ['inApp', 'system']);
        return;
      }

      if (previous !== 'running' && state === 'running' && disconnectNotified) {
        sequence += 1;
        disconnectNotified = false;
        deps.notifier.notify(
          { id: `daemon:${sequence}`, level: 'success', title: 'Daemon 连接已恢复' },
          ['inApp', 'system'],
        );
      }
    },
  };
}
