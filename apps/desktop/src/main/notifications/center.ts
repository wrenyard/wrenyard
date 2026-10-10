import type { AppNotification } from './notifier.js';

/** One history entry: the delivered notification plus its history metadata. */
export interface NotificationEntry extends AppNotification {
  /** Epoch milliseconds; assigned once when the id first appears. */
  createdAt: number;
  read: boolean;
}

/** Renderer-facing projection of the in-app history. */
export interface NotificationSnapshot {
  /** Newest first. */
  items: NotificationEntry[];
  unreadCount: number;
}

/** Session-only history bound. */
const NOTIFICATION_HISTORY_CAPACITY = 200;

export interface NotificationCenterDeps {
  now?(): number;
  capacity?: number;
  /** Invoked after every mutation. */
  onChange(): void;
}

export class NotificationCenter {
  private readonly now: () => number;
  private readonly capacity: number;
  private readonly onChange: () => void;
  /** Kept newest-first so the oldest entry is always at the end. */
  private items: NotificationEntry[] = [];

  constructor(deps: NotificationCenterDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.capacity = deps.capacity ?? NOTIFICATION_HISTORY_CAPACITY;
    this.onChange = deps.onChange;
  }

  /**
   * Insert or replace an entry by id: a same-id update is moved to the top,
   * marked unread and keeps the original `createdAt`.
   */
  add(notification: AppNotification): void {
    const index = this.items.findIndex((entry) => entry.id === notification.id);
    const createdAt = index >= 0 ? this.items[index]!.createdAt : this.now();
    if (index >= 0) this.items.splice(index, 1);
    this.items.unshift({ ...notification, createdAt, read: false });
    this.enforceCapacity();
    this.onChange();
  }

  /** Remove the entry with this id. */
  remove(id: string): void {
    const next = this.items.filter((entry) => entry.id !== id);
    if (next.length === this.items.length) return;
    this.items = next;
    this.onChange();
  }

  /** Remove every entry. */
  clear(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.onChange();
  }

  /** Mark the whole history read. */
  markAllRead(): void {
    if (this.items.every((entry) => entry.read)) return;
    this.items = this.items.map((entry) => (entry.read ? entry : { ...entry, read: true }));
    this.onChange();
  }

  snapshot(): NotificationSnapshot {
    return {
      items: this.items.map((entry) => ({ ...entry })),
      unreadCount: this.items.reduce((count, entry) => (entry.read ? count : count + 1), 0),
    };
  }

  /** Drop the oldest entry once the history is over capacity. */
  private enforceCapacity(): void {
    while (this.items.length > this.capacity) this.items.pop();
  }
}
