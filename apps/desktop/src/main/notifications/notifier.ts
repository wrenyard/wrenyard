export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

/**
 * A serializable reference to a command-table entry. Actions cross the
 * process boundary only in this shape — a renderer callback is never sent.
 */
export interface NotificationCommandAction {
  id: string;
  args?: unknown;
}

export interface NotificationAction {
  label: string;
  command: NotificationCommandAction;
}

export interface AppNotification {
  id: string;
  level: NotificationLevel;
  title: string;
  body?: string;
  action?: NotificationAction;
}

/** The three delivery channels a producer may name. */
export type NotificationChannel = 'inApp' | 'pet' | 'system';

/** Minimal sink shape shared by every channel. */
export interface NotificationChannelSink {
  show(notification: AppNotification): void;
}

export interface NotifierDeps {
  /** Single gate: `notifications.enabled`. False shows nothing anywhere. */
  isEnabled(): boolean;
  inApp: NotificationChannelSink;
  pet: NotificationChannelSink;
  system: NotificationChannelSink;
}

export class Notifier {
  constructor(private readonly deps: NotifierDeps) {}

  /**
   * Deliver one notification over the named channels. While disabled nothing
   * is shown and nothing is recorded on any channel.
   */
  notify(notification: AppNotification, channels: readonly NotificationChannel[]): void {
    if (!this.deps.isEnabled()) return;
    for (const channel of channels) {
      if (channel === 'inApp') this.deps.inApp.show(notification);
      else if (channel === 'pet') this.deps.pet.show(notification);
      else this.deps.system.show(notification);
    }
  }
}
