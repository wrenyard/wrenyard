// ── Desktop notification center ──────────────────────────────────────
// The single owner of event notifications for the whole Desktop process.
// It keeps the most recent 200 notifications of THIS run in memory only
// (never written to disk, cleared on exit, matching VS Code), so a window
// in the background — or with the main window closed — never loses an
// event. Renderer-originated and main-originated events both land here;
// the renderer only renders the projection it reads back over IPC.

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

/**
 * Event families that produce notifications. Kept open-ended so later
 * features can add a source without touching the center.
 */
export type NotificationSource =
  | 'task'
  | 'session'
  | 'update'
  | 'daemon'
  | 'quota'
  | 'settings'
  | 'pet'
  | 'system';

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

export interface ShellNotification {
  id: string;
  level: NotificationLevel;
  source: NotificationSource;
  title: string;
  description?: string;
  action?: NotificationAction;
  /** Epoch milliseconds; assigned once when the id first appears. */
  createdAt: number;
  read: boolean;
}

export interface NotificationInput {
  /** Same id updates the existing notification instead of adding a new one. */
  id?: string;
  level: NotificationLevel;
  source: NotificationSource;
  title: string;
  description?: string;
  action?: NotificationAction;
}

export interface NotificationSnapshot {
  items: ShellNotification[];
  unreadCount: number;
  doNotDisturb: boolean;
}

/** Session-only history bound, matching the interaction foundations spec. */
export const NOTIFICATION_CAPACITY = 200;

export interface NotificationCenterOptions {
  now?: () => number;
  capacity?: number;
  /** Invoked after every mutation with a fresh snapshot. */
  onChanged?: (snapshot: NotificationSnapshot) => void;
  /** Whether the main shell window is currently focused. */
  isForeground?: () => boolean;
  /** Whether OS-level notifications are enabled in preferences. */
  isSystemEnabled?: () => boolean;
  /** Emit a native notification; only called for background-worthy events. */
  onSystemNotification?: (notification: ShellNotification) => void;
  /** Initial do-not-disturb state; the owner persists later toggles. */
  doNotDisturb?: boolean;
}

/**
 * In-memory, partition-free notification store. A notification is
 * background-worthy only when the window is not focused and the event is a
 * warning, an error or a completed task; do-not-disturb suppresses both
 * the toast and the OS notification except for errors.
 */
export class NotificationCenter {
  private readonly now: () => number;
  private readonly capacity: number;
  private readonly onChanged: ((snapshot: NotificationSnapshot) => void) | undefined;
  private readonly isForeground: () => boolean;
  private readonly isSystemEnabled: () => boolean;
  private readonly onSystemNotification: ((notification: ShellNotification) => void) | undefined;
  private items: ShellNotification[] = [];
  private doNotDisturb: boolean;
  private sequence = 0;

  constructor(options: NotificationCenterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.capacity = options.capacity ?? NOTIFICATION_CAPACITY;
    this.onChanged = options.onChanged;
    this.isForeground = options.isForeground ?? (() => true);
    this.isSystemEnabled = options.isSystemEnabled ?? (() => true);
    this.onSystemNotification = options.onSystemNotification;
    this.doNotDisturb = options.doNotDisturb ?? false;
  }

  isDoNotDisturb(): boolean {
    return this.doNotDisturb;
  }

  setDoNotDisturb(value: boolean): void {
    if (this.doNotDisturb === value) return;
    this.doNotDisturb = value;
    this.emit();
  }

  /** Insert or update a notification; returns the stored (cloned) record. */
  push(input: NotificationInput): ShellNotification {
    const index = input.id === undefined ? -1 : this.items.findIndex((item) => item.id === input.id);
    let notification: ShellNotification;
    if (index >= 0) {
      const existing = this.items[index]!;
      notification = {
        id: existing.id,
        level: input.level,
        source: input.source,
        title: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.action !== undefined ? { action: cloneAction(input.action) } : {}),
        createdAt: existing.createdAt,
        read: false,
      };
      // An update re-surfaces the notification at the top of the list.
      this.items.splice(index, 1);
    } else {
      notification = {
        id: input.id ?? this.nextId(),
        level: input.level,
        source: input.source,
        title: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.action !== undefined ? { action: cloneAction(input.action) } : {}),
        createdAt: this.now(),
        read: false,
      };
    }
    this.items.unshift(notification);
    if (this.items.length > this.capacity) this.items.length = this.capacity;
    this.emit();
    if (this.shouldSystemNotify(notification)) this.onSystemNotification?.(cloneNotification(notification));
    return cloneNotification(notification);
  }

  /** Newest first. */
  list(): ShellNotification[] {
    return this.items.map(cloneNotification);
  }

  markAllRead(): void {
    if (this.items.every((item) => item.read)) return;
    this.items = this.items.map((item) => (item.read ? item : { ...item, read: true }));
    this.emit();
  }

  dismiss(id: string): void {
    const next = this.items.filter((item) => item.id !== id);
    if (next.length === this.items.length) return;
    this.items = next;
    this.emit();
  }

  clear(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.emit();
  }

  snapshot(): NotificationSnapshot {
    return {
      items: this.list(),
      unreadCount: this.items.reduce((count, item) => (item.read ? count : count + 1), 0),
      doNotDisturb: this.doNotDisturb,
    };
  }

  private shouldSystemNotify(notification: ShellNotification): boolean {
    if (!this.isSystemEnabled()) return false;
    // Do-not-disturb keeps history only; an error still surfaces.
    if (this.doNotDisturb && notification.level !== 'error') return false;
    if (this.isForeground()) return false;
    return notification.level === 'warning'
      || notification.level === 'error'
      || notification.source === 'task';
  }

  private nextId(): string {
    this.sequence += 1;
    return `notification-${this.now()}-${this.sequence}`;
  }

  private emit(): void {
    this.onChanged?.(this.snapshot());
  }
}

function cloneAction(action: NotificationAction): NotificationAction {
  return {
    label: action.label,
    command: {
      id: action.command.id,
      ...(action.command.args !== undefined ? { args: action.command.args } : {}),
    },
  };
}

function cloneNotification(notification: ShellNotification): ShellNotification {
  return {
    id: notification.id,
    level: notification.level,
    source: notification.source,
    title: notification.title,
    ...(notification.description !== undefined ? { description: notification.description } : {}),
    ...(notification.action !== undefined ? { action: cloneAction(notification.action) } : {}),
    createdAt: notification.createdAt,
    read: notification.read,
  };
}
