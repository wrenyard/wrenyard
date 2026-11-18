import type { InboxEntry, InboxMode, RecoveryWaitState } from './types.ts';

/**
 * Synchronous same-tick dedup latch keyed by request fingerprint. Identical
 * concurrent invocations before settlement share one in-flight promise.
 */
export class PendingSendLatch<T> {
  private readonly pending = new Map<string, Promise<T>>();

  get size(): number {
    return this.pending.size;
  }

  has(fingerprint: string): boolean {
    return this.pending.has(fingerprint);
  }

  hasPrefix(prefix: string): boolean {
    for (const key of this.pending.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  get(fingerprint: string): Promise<T> | undefined {
    return this.pending.get(fingerprint);
  }

  run(fingerprint: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(fingerprint);
    if (existing !== undefined) return existing;
    const raw = factory();
    const tracked = raw.finally(() => {
      if (this.pending.get(fingerprint) === tracked) {
        this.pending.delete(fingerprint);
      }
    });
    this.pending.set(fingerprint, tracked);
    return tracked;
  }

  clear(fingerprint?: string): void {
    if (fingerprint === undefined) this.pending.clear();
    else this.pending.delete(fingerprint);
  }
}

/**
 * Per-turn recovery wait marker fenced by turn number so settling or
 * cancelling another turn never clears an active wait.
 */
export class RecoveryWaitLatch {
  private state: RecoveryWaitState | undefined;

  get current(): RecoveryWaitState | undefined {
    return this.state === undefined ? undefined : { ...this.state };
  }

  set(state: RecoveryWaitState): void;
  set(turn: number, key: string): void;
  set(stateOrTurn: RecoveryWaitState | number, key?: string): void {
    if (typeof stateOrTurn === 'number') {
      this.state = { turn: stateOrTurn, key: key ?? '' };
    } else {
      this.state = { turn: stateOrTurn.turn, key: stateOrTurn.key };
    }
  }

  matches(key: string): RecoveryWaitState | undefined {
    if (this.state === undefined || this.state.key !== key) return undefined;
    return { ...this.state };
  }

  clear(turn: number): boolean {
    if (this.state?.turn !== turn) return false;
    this.state = undefined;
    return true;
  }

  reset(): void {
    this.state = undefined;
  }
}

/**
 * Ordered per-mode session input inbox (`followup`, `steer`, `inject`).
 */
export class SessionInbox<TInput = unknown> {
  private readonly queues: Record<InboxMode, InboxEntry<TInput>[]> = {
    followup: [],
    steer: [],
    inject: [],
  };

  get size(): number {
    return this.queues.followup.length + this.queues.steer.length + this.queues.inject.length;
  }

  enqueue(mode: InboxMode, id: string, input: TInput, now: Date): InboxEntry<TInput> {
    const entry: InboxEntry<TInput> = {
      id,
      mode,
      input,
      queuedAt: now.toISOString(),
    };
    this.queues[mode].push(entry);
    return { ...entry };
  }

  drain(mode: InboxMode): InboxEntry<TInput>[] {
    const items = this.queues[mode];
    if (items.length === 0) return [];
    this.queues[mode] = [];
    return items.map((entry) => ({ ...entry }));
  }

  peek(mode: InboxMode): readonly InboxEntry<TInput>[] {
    return this.queues[mode].map((entry) => ({ ...entry }));
  }

  has(mode?: InboxMode): boolean {
    if (mode !== undefined) return this.queues[mode].length > 0;
    return this.size > 0;
  }

  clearOnInterrupt(keepFollowup = false): void {
    this.queues.steer = [];
    this.queues.inject = [];
    if (!keepFollowup) {
      this.queues.followup = [];
    }
  }

  clear(): void {
    this.queues.followup = [];
    this.queues.steer = [];
    this.queues.inject = [];
  }
}
