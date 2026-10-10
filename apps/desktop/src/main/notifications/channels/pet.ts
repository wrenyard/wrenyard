import type { BroadcastInput } from '../../../pet/shared/broadcast.js';
import type { AppNotification, NotificationChannelSink } from '../notifier.js';

/** How long a Pet notification bubble stays on screen before fading. */
const PET_BUBBLE_DURATION_MS = 8_000;

export interface PetChannelDeps {
  /** The Pet runtime entry point; a no-op while the runtime is stopped. */
  showBubble(broadcast: BroadcastInput): void;
  now?(): number;
}

export function createPetChannel(deps: PetChannelDeps): NotificationChannelSink {
  const now = deps.now ?? (() => Date.now());
  let sequence = 0;
  return {
    show(notification: AppNotification): void {
      sequence += 1;
      const body = notification.body?.trim() ?? '';
      const text = `${notification.title}\n${body}`;
      deps.showBubble({
        id: `pet-notification-${now()}-${sequence}`,
        text,
        untilMs: now() + PET_BUBBLE_DURATION_MS,
      });
    },
  };
}
