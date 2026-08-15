export interface AsyncPollTimerApi {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface PollEntry {
  generation: number;
  timer: unknown | null;
}

const DEFAULT_TIMER_API: AsyncPollTimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Schedules one async poll at a time per key. Replacing or stopping a poll
 * invalidates its in-flight callback so stale work cannot publish or reschedule.
 */
export class SerializedAsyncPoller {
  private readonly entries = new Map<string, PollEntry>();
  private generation = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly timers: AsyncPollTimerApi = DEFAULT_TIMER_API,
  ) {}

  start(
    key: string,
    poll: (isCurrent: () => boolean) => Promise<boolean>,
    onError?: (error: unknown) => void,
    runImmediately: boolean = false,
  ): void {
    this.stop(key);
    const entry: PollEntry = { generation: ++this.generation, timer: null };
    this.entries.set(key, entry);
    if (runImmediately) void this.run(key, entry, poll, onError);
    else this.schedule(key, entry, poll, onError);
  }

  isActive(key: string): boolean {
    return this.entries.has(key);
  }

  stop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.timer !== null) this.timers.clearTimeout(entry.timer);
    this.entries.delete(key);
  }

  stopAll(): void {
    for (const key of [...this.entries.keys()]) this.stop(key);
  }

  private isCurrent(key: string, entry: PollEntry): boolean {
    return this.entries.get(key) === entry;
  }

  private schedule(
    key: string,
    entry: PollEntry,
    poll: (isCurrent: () => boolean) => Promise<boolean>,
    onError?: (error: unknown) => void,
  ): void {
    entry.timer = this.timers.setTimeout(() => {
      entry.timer = null;
      void this.run(key, entry, poll, onError);
    }, this.intervalMs);
  }

  private async run(
    key: string,
    entry: PollEntry,
    poll: (isCurrent: () => boolean) => Promise<boolean>,
    onError?: (error: unknown) => void,
  ): Promise<void> {
    const isCurrent = (): boolean => this.isCurrent(key, entry);
    if (!isCurrent()) return;

    try {
      const shouldContinue = await poll(isCurrent);
      if (!isCurrent()) return;
      if (!shouldContinue) {
        this.entries.delete(key);
        return;
      }
    } catch (error) {
      if (!isCurrent()) return;
      onError?.(error);
    }

    if (isCurrent()) this.schedule(key, entry, poll, onError);
  }
}
