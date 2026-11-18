import { RecoveryWaitLatch, SessionInbox } from './inbox.ts';
import type { Projector, SessionStorageHandle } from './ports.ts';
import { ProjectionCache } from './projection.ts';
import { Timeline } from './timeline.ts';
import type {
  SessionEventBase,
  SessionEventDraft,
  SessionPage,
  SessionStatus,
  SessionSummaryBase,
  SubSessionSpec,
} from './types.ts';

export class TurnRecord<TInput = unknown> {
  readonly turn: number;
  readonly input: TInput;
  readonly abort = new AbortController();
  finished = false;
  durableTerminal = false;
  status?: 'completed' | 'failed' | 'interrupted';
  error?: unknown;
  private readonly lateWork = new Set<Promise<unknown>>();
  private readonly waiters = new Set<() => void>();
  private readonly onSettled?: () => void;

  constructor(turn: number, input: TInput, onSettled?: () => void) {
    this.turn = turn;
    this.input = input;
    this.onSettled = onSettled;
  }

  get lateWorkCount(): number {
    return this.lateWork.size;
  }

  hasLateWork(): boolean {
    return this.lateWork.size > 0;
  }

  trackWork<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => {
      this.lateWork.delete(tracked);
      this.checkSettled();
    });
    this.lateWork.add(tracked);
    // Keep detached tracked work from triggering unhandled rejection crashes.
    void tracked.catch(() => undefined);
    return tracked;
  }

  async awaitLateWork(): Promise<void> {
    while (this.lateWork.size > 0) {
      await Promise.allSettled([...this.lateWork]);
    }
  }

  markDurableTerminal(status?: 'completed' | 'failed' | 'interrupted', error?: unknown): void {
    this.finished = true;
    this.durableTerminal = true;
    if (status !== undefined) this.status = status;
    if (error !== undefined) this.error = error;
    this.checkSettled();
  }

  whenIdle(): Promise<void> {
    if (this.durableTerminal && this.lateWork.size === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.add(resolve);
    });
  }

  notifyIfIdle(): void {
    this.checkSettled();
  }

  private checkSettled(): void {
    if (this.durableTerminal && this.lateWork.size === 0) {
      for (const resolve of [...this.waiters]) {
        this.waiters.delete(resolve);
        resolve();
      }
    }
    this.onSettled?.();
  }
}

export interface ManagedSessionOptions<
  E extends SessionEventBase,
  TTurnInput = unknown,
  TSummary extends SessionSummaryBase = SessionSummaryBase,
> {
  sessionId: string;
  handle: SessionStorageHandle<E, TSummary>;
  now?: () => Date;
  timeline?: Timeline<E>;
}

/**
 * Resident runtime view of one active session, binding its single-writer
 * storage handle, timeline, projection cache, inbox, turn table, and
 * sub-session spawning.
 */
export class ManagedSession<
  E extends SessionEventBase = SessionEventBase,
  TTurnInput = unknown,
  TSummary extends SessionSummaryBase = SessionSummaryBase,
> {
  readonly sessionId: string;
  readonly handle: SessionStorageHandle<E, TSummary>;
  readonly timeline: Timeline<E>;
  readonly inbox = new SessionInbox<TTurnInput>();
  readonly projections: ProjectionCache<E>;
  readonly recoveryWait = new RecoveryWaitLatch();
  readonly turns = new Map<number, TurnRecord<TTurnInput>>();
  nextTurn: number;

  private readonly now: () => Date;
  private readonly waiters = new Set<() => void>();
  private readonly subControllers = new Set<AbortController>();
  private activeSubSessions = 0;
  private subSeq = 0;
  private closed = false;

  constructor(options: ManagedSessionOptions<E, TTurnInput, TSummary>) {
    this.sessionId = options.sessionId;
    this.handle = options.handle;
    this.now = options.now ?? (() => new Date());
    this.timeline = options.timeline ?? new Timeline<E>(options.handle.read());
    this.projections = new ProjectionCache<E>(this.timeline);
    this.nextTurn = computeNextTurn(this.timeline.view());
  }

  get status(): SessionStatus {
    if (this.recoveryWait.current !== undefined) return 'waiting';
    if (this.hasRunningTurns()) return 'running';
    return 'idle';
  }

  hasRunningTurns(): boolean {
    return this.activeTurnCount() > 0;
  }

  activeTurnCount(): number {
    let count = 0;
    for (const turn of this.turns.values()) {
      if (!turn.durableTerminal) count += 1;
    }
    return count;
  }

  read(): E[] {
    return this.timeline.read();
  }

  readPage(afterSeq: number, limit: number): SessionPage<E> {
    return this.timeline.page(afterSeq, limit);
  }

  project<TView>(projector: Projector<E, TView>): TView {
    return this.projections.get(projector);
  }

  summary(): TSummary | undefined {
    return this.handle.summary();
  }

  async append(draft: SessionEventDraft<E>): Promise<E> {
    const event = await this.handle.append(draft);
    if (event.seq > this.timeline.lastSeq) {
      this.timeline.commit(event);
    }
    if (typeof event.turn === 'number' && event.turn >= this.nextTurn) {
      this.nextTurn = event.turn + 1;
    }
    return event;
  }

  async flush(): Promise<void> {
    await this.handle.flush();
  }

  createTurn(turn: number, input: TTurnInput): TurnRecord<TTurnInput> {
    const record = new TurnRecord<TTurnInput>(turn, input, () => this.notifyIfIdle());
    this.turns.set(turn, record);
    if (turn >= this.nextTurn) {
      this.nextTurn = turn + 1;
    }
    return record;
  }

  markTurnDurableTerminal(
    turn: number,
    status?: 'completed' | 'failed' | 'interrupted',
    error?: unknown,
  ): void {
    const record = this.turns.get(turn);
    if (record !== undefined) {
      record.markDurableTerminal(status, error);
    }
    this.recoveryWait.clear(turn);
    this.notifyIfIdle();
  }

  whenIdle(): Promise<void> {
    if (this.isExecutionIdle()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.add(resolve);
    });
  }

  async spawnSubSession<TSubInput, TSubResult = void>(
    spec: SubSessionSpec<TSubInput>,
    runner: (
      subSessionId: string,
      signal: AbortSignal,
      spec: SubSessionSpec<TSubInput>,
    ) => Promise<TSubResult>,
    options?: { subSessionId?: string; signal?: AbortSignal },
  ): Promise<TSubResult> {
    const subSessionId = options?.subSessionId ?? `${this.sessionId}__sub_${++this.subSeq}`;
    const controller = new AbortController();
    const external = options?.signal;
    const onExternalAbort = (): void => controller.abort();
    if (this.closed || external?.aborted) {
      controller.abort();
    } else if (external !== undefined) {
      external.addEventListener('abort', onExternalAbort, { once: true });
    }

    this.subControllers.add(controller);
    this.activeSubSessions += 1;
    try {
      return await runner(subSessionId, controller.signal, spec);
    } finally {
      if (external !== undefined) {
        external.removeEventListener('abort', onExternalAbort);
      }
      this.subControllers.delete(controller);
      this.activeSubSessions -= 1;
      this.notifyIfIdle();
    }
  }

  isQuiescent(): boolean {
    if (!this.isExecutionIdle()) return false;
    if (this.inbox.size > 0) return false;
    if (this.recoveryWait.current !== undefined) return false;
    return true;
  }

  notifyIfIdle(): void {
    if (!this.isExecutionIdle()) return;
    for (const resolve of [...this.waiters]) {
      this.waiters.delete(resolve);
      resolve();
    }
  }

  currentTime(): Date {
    return this.now();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.subControllers) {
      controller.abort();
    }
    for (const turn of this.turns.values()) {
      if (!turn.abort.signal.aborted) {
        turn.abort.abort();
      }
    }
    await this.handle.close();
  }

  private isExecutionIdle(): boolean {
    if (this.activeSubSessions > 0) return false;
    for (const turn of this.turns.values()) {
      if (!turn.durableTerminal || turn.hasLateWork()) return false;
    }
    return true;
  }
}

function computeNextTurn<E extends SessionEventBase>(events: readonly E[]): number {
  let nextTurn = 1;
  for (const event of events) {
    if (typeof event.turn === 'number' && event.turn >= nextTurn) {
      nextTurn = event.turn + 1;
    }
  }
  return nextTurn;
}
