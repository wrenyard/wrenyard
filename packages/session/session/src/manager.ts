import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionBusyError,
  SessionClosedError,
  SessionNotFoundError,
} from './errors.ts';
import { SessionReadOnlyError } from './errors.ts';
import { analyzeTailRepair, buildForkSeed, type TailRepairPlan } from './fork.ts';
import { PendingSendLatch } from './inbox.ts';
import { LiveStreamHub } from './live.ts';
import type {
  SessionDriverContext,
  SessionDriverPort,
  SessionPersistencePort,
  SessionStorageHandle,
  SessionStorageMode,
} from './ports.ts';
import { ManagedSession } from './session.ts';
import { pageEvents, snapshotJsonValue } from './timeline.ts';
import type {
  LiveFrame,
  SessionEventBase,
  SessionEventDraft,
  SessionPage,
  SessionSummaryBase,
} from './types.ts';

const DEFAULT_MEMORY_TITLE = 'New session';
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

function assertValidMemorySessionId(sessionId: string): void {
  if (
    sessionId === ''
    || sessionId === '.'
    || sessionId === '..'
    || /[/\\\u0000]/u.test(sessionId)
  ) {
    throw new Error(`invalid session id: ${sessionId}`);
  }
}

interface MemorySessionRecord<
  E extends SessionEventBase,
  TSummary extends SessionSummaryBase,
> {
  events: E[];
  summary: TSummary;
  bytes: number;
}

class MemoryStorageHandle<
  E extends SessionEventBase,
  TSummary extends SessionSummaryBase,
> implements SessionStorageHandle<E, TSummary> {
  readonly sessionId: string;
  readonly mode: SessionStorageMode;
  private closed = false;

  constructor(
    sessionId: string,
    mode: SessionStorageMode,
    private readonly backend: MemorySessionPersistence<E, TSummary>,
    private readonly onClose: () => void,
  ) {
    this.sessionId = sessionId;
    this.mode = mode;
  }

  read(): E[] {
    this.assertOpen();
    return this.backend.read(this.sessionId);
  }

  readPage(afterSeq: number, limit: number): SessionPage<E> {
    this.assertOpen();
    return this.backend.readPage(this.sessionId, afterSeq, limit);
  }

  async append(draft: SessionEventDraft<E>): Promise<E> {
    this.assertWritable();
    return this.backend.appendFromHandle(this.sessionId, draft);
  }

  async appendBatch(drafts: readonly SessionEventDraft<E>[]): Promise<E[]> {
    this.assertWritable();
    return this.backend.appendBatchFromHandle(this.sessionId, drafts);
  }

  async flush(): Promise<void> {
    this.assertWritable();
    return this.backend.flush();
  }

  summary(): TSummary | undefined {
    this.assertOpen();
    return this.backend.stat(this.sessionId);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.onClose();
    return Promise.resolve();
  }

  forceClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private assertOpen(): void {
    if (this.closed) throw new SessionClosedError();
  }

  private assertWritable(): void {
    this.assertOpen();
    if (this.mode === 'read') throw new SessionReadOnlyError(this.sessionId);
  }
}

/**
 * Pure in-memory implementation of {@link SessionPersistencePort}.
 * Used as the default persistence adapter when `createSessionManager` is
 * constructed without an explicit durable backend.
 */
export class MemorySessionPersistence<
  E extends SessionEventBase = SessionEventBase,
  TSummary extends SessionSummaryBase = SessionSummaryBase,
> implements SessionPersistencePort<E, TSummary> {
  private readonly now: () => Date;
  private readonly sessions = new Map<string, MemorySessionRecord<E, TSummary>>();
  private readonly writers = new Map<string, MemoryStorageHandle<E, TSummary>>();
  private readonly handles = new Map<string, Set<MemoryStorageHandle<E, TSummary>>>();
  private readonly listeners = new Map<string, Set<(event: E) => void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options?: { now?: () => Date }) {
    this.now = options?.now ?? (() => new Date());
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  async create(
    sessionId: string,
    initialDrafts?: readonly SessionEventDraft<E>[],
    _options?: { isSeed?: boolean },
  ): Promise<SessionStorageHandle<E, TSummary>> {
    this.assertOpen();
    assertValidMemorySessionId(sessionId);
    return this.enqueue(async () => {
      this.assertOpen();
      if (this.sessions.has(sessionId)) {
        throw new SessionAlreadyExistsError(sessionId);
      }
      if (this.writers.has(sessionId)) {
        throw new SessionAlreadyOwnedError(sessionId);
      }
      const createdAt = this.now().toISOString();
      const events: E[] = [];
      let bytes = 0;
      const pendingSet = new Set<number>();
      let seq = 0;

      if (initialDrafts !== undefined) {
        for (const draft of initialDrafts) {
          seq += 1;
          const event = snapshotJsonValue({
            ...(draft as Record<string, unknown>),
            seq,
            at: this.now().toISOString(),
          }) as unknown as E;
          bytes += JSON.stringify(event).length + 1;
          events.push(event);
          updatePendingSet(pendingSet, event);
        }
      }

      const summary = deriveMemorySummary<E, TSummary>(
        sessionId,
        events,
        createdAt,
        bytes,
        pendingSet,
      );
      this.sessions.set(sessionId, { events, summary, bytes });
      const handle = this.createHandle(sessionId, 'write');
      for (const event of events) {
        this.emit(sessionId, event);
      }
      return handle;
    });
  }

  async open(
    sessionId: string,
    mode: SessionStorageMode,
  ): Promise<SessionStorageHandle<E, TSummary>> {
    this.assertOpen();
    assertValidMemorySessionId(sessionId);
    if (mode === 'write' && this.writers.has(sessionId)) {
      throw new SessionAlreadyOwnedError(sessionId);
    }
    return this.enqueue(async () => {
      this.assertOpen();
      if (!this.sessions.has(sessionId)) {
        throw new SessionNotFoundError(sessionId);
      }
      if (mode === 'write' && this.writers.has(sessionId)) {
        throw new SessionAlreadyOwnedError(sessionId);
      }
      return this.createHandle(sessionId, mode);
    });
  }

  stat(sessionId: string): TSummary | undefined {
    assertValidMemorySessionId(sessionId);
    const record = this.sessions.get(sessionId);
    if (record === undefined) return undefined;
    return {
      ...record.summary,
      ...(record.summary.pendingTurns === undefined
        ? {}
        : { pendingTurns: [...record.summary.pendingTurns] }),
    };
  }

  list(): TSummary[] {
    return [...this.sessions.values()]
      .map((record) => ({
        ...record.summary,
        ...(record.summary.pendingTurns === undefined
          ? {}
          : { pendingTurns: [...record.summary.pendingTurns] }),
      }))
      .sort((a, b) => {
        if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
        return a.sessionId.localeCompare(b.sessionId);
      });
  }

  read(sessionId: string): E[] {
    assertValidMemorySessionId(sessionId);
    const record = this.sessions.get(sessionId);
    return record === undefined ? [] : [...record.events];
  }

  readPage(sessionId: string, afterSeq: number, limit: number): SessionPage<E> {
    assertValidMemorySessionId(sessionId);
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new SessionNotFoundError(sessionId);
    }
    return pageEvents(record.events, afterSeq, limit);
  }

  subscribe(sessionId: string, listener: (event: E) => void): () => void {
    assertValidMemorySessionId(sessionId);
    let set = this.listeners.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    const current = set;
    return () => {
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(sessionId);
      }
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.assertOpen();
    assertValidMemorySessionId(sessionId);
    return this.enqueue(async () => {
      this.assertOpen();
      if (!this.sessions.has(sessionId)) {
        throw new SessionNotFoundError(sessionId);
      }
      const handles = this.handles.get(sessionId);
      if (handles !== undefined) {
        for (const handle of [...handles]) {
          handle.forceClose();
        }
      }
      this.writers.delete(sessionId);
      this.handles.delete(sessionId);
      this.sessions.delete(sessionId);
      this.listeners.delete(sessionId);
    });
  }

  async flush(): Promise<void> {
    this.assertOpen();
    await this.queue.catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue.catch(() => undefined);
    for (const set of [...this.handles.values()]) {
      for (const handle of [...set]) {
        handle.forceClose();
      }
    }
    this.handles.clear();
    this.writers.clear();
    this.listeners.clear();
  }

  /** @internal */
  appendFromHandle(sessionId: string, draft: SessionEventDraft<E>): Promise<E> {
    return this.enqueue(async () => {
      this.assertOpen();
      const record = this.sessions.get(sessionId);
      if (record === undefined) {
        throw new SessionNotFoundError(sessionId);
      }
      const prevSeq = record.events.length > 0 ? record.events[record.events.length - 1]!.seq : 0;
      const event = snapshotJsonValue({
        ...(draft as Record<string, unknown>),
        seq: prevSeq + 1,
        at: this.now().toISOString(),
      }) as unknown as E;
      record.events.push(event);
      record.bytes += JSON.stringify(event).length + 1;
      record.summary = advanceMemorySummary(record.summary, event, record.bytes);
      this.emit(sessionId, event);
      return event;
    });
  }

  /** @internal */
  appendBatchFromHandle(
    sessionId: string,
    drafts: readonly SessionEventDraft<E>[],
  ): Promise<E[]> {
    return this.enqueue(async () => {
      this.assertOpen();
      const record = this.sessions.get(sessionId);
      if (record === undefined) {
        throw new SessionNotFoundError(sessionId);
      }
      if (drafts.length === 0) return [];
      let seq = record.events.length > 0 ? record.events[record.events.length - 1]!.seq : 0;
      const appended: E[] = [];
      let addedBytes = 0;
      for (const draft of drafts) {
        seq += 1;
        const event = snapshotJsonValue({
          ...(draft as Record<string, unknown>),
          seq,
          at: this.now().toISOString(),
        }) as unknown as E;
        addedBytes += JSON.stringify(event).length + 1;
        appended.push(event);
      }
      for (const event of appended) {
        record.events.push(event);
      }
      record.bytes += addedBytes;
      for (const event of appended) {
        record.summary = advanceMemorySummary(record.summary, event, record.bytes);
        this.emit(sessionId, event);
      }
      return appended;
    });
  }

  private createHandle(
    sessionId: string,
    mode: SessionStorageMode,
  ): MemoryStorageHandle<E, TSummary> {
    let set = this.handles.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.handles.set(sessionId, set);
    }
    const handle = new MemoryStorageHandle<E, TSummary>(sessionId, mode, this, () => {
      if (mode === 'write' && this.writers.get(sessionId) === handle) {
        this.writers.delete(sessionId);
      }
      const tracked = this.handles.get(sessionId);
      if (tracked !== undefined) {
        tracked.delete(handle);
        if (tracked.size === 0) {
          this.handles.delete(sessionId);
        }
      }
    });
    set.add(handle);
    if (mode === 'write') {
      this.writers.set(sessionId, handle);
    }
    return handle;
  }

  private emit(sessionId: string, event: E): void {
    const set = this.listeners.get(sessionId);
    if (set === undefined) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // Isolate subscriber errors from persistence writes.
      }
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private assertOpen(): void {
    if (this.closed) throw new SessionClosedError();
  }
}

function updatePendingSet(pending: Set<number>, event: SessionEventBase): void {
  if (typeof event.turn !== 'number') return;
  if (event.type === 'turn.started') pending.add(event.turn);
  else if (event.type === 'turn.finished') pending.delete(event.turn);
}

function deriveMemorySummary<
  E extends SessionEventBase,
  TSummary extends SessionSummaryBase,
>(
  sessionId: string,
  events: readonly E[],
  fallbackCreatedAt: string,
  bytes: number,
  pendingSet: ReadonlySet<number>,
): TSummary {
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let title = DEFAULT_MEMORY_TITLE;
  let manualTitle = false;

  for (const event of events) {
    if (event.type === 'session.created') createdAt = event.at;
    const titled = readTitleField(event);
    if (titled !== undefined && (!manualTitle || titled.manual)) {
      title = titled.title;
      manualTitle = titled.manual;
    }
    updatedAt = event.at;
  }

  const created = createdAt ?? (events.length > 0 ? events[0]!.at : fallbackCreatedAt);
  const updated = updatedAt ?? created;
  const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
  return {
    sessionId,
    title,
    createdAt: created,
    updatedAt: updated,
    lastSeq,
    pendingTurns: [...pendingSet].sort((a, b) => a - b),
    bytes,
  } as TSummary;
}

function advanceMemorySummary<
  E extends SessionEventBase,
  TSummary extends SessionSummaryBase,
>(
  previous: TSummary,
  event: E,
  bytes: number,
): TSummary {
  const rec = previous as Record<string, unknown>;
  let title = previous.title;
  let manualTitle = rec.manualTitle === true;
  const titled = readTitleField(event);
  if (titled !== undefined && (!manualTitle || titled.manual)) {
    title = titled.title;
    manualTitle = titled.manual;
  }
  const pending = new Set(previous.pendingTurns ?? []);
  updatePendingSet(pending, event);
  const createdAt = event.type === 'session.created' ? event.at : previous.createdAt;
  return {
    ...previous,
    title,
    ...(manualTitle ? { manualTitle: true } : {}),
    createdAt,
    updatedAt: event.at,
    lastSeq: event.seq,
    pendingTurns: [...pending].sort((a, b) => a - b),
    bytes,
  };
}

function readTitleField(event: SessionEventBase): { title: string; manual: boolean } | undefined {
  if (event.type !== 'session.titled') return undefined;
  const rec = event as unknown as Record<string, unknown>;
  if (typeof rec.text !== 'string') return undefined;
  const trimmed = rec.text.trim();
  return trimmed === '' ? undefined : { title: trimmed, manual: rec.manual === true };
}

export interface SessionManagerOptions<
  E extends SessionEventBase = SessionEventBase,
  TSummary extends SessionSummaryBase = SessionSummaryBase,
  TTurnInput = unknown,
  TResult = void,
> {
  persistence?: SessionPersistencePort<E, TSummary>;
  driver?: SessionDriverPort<E, TTurnInput, TResult>;
  now?: () => Date;
  idleTimeoutMs?: number;
  sweepIntervalMs?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous manager peers in process
  peerGroup?: Set<SessionManager<any, any, any, any>>;
  onRecover?: (ctx: {
    sessionId: string;
    events: readonly E[];
    repair: TailRepairPlan<E>;
  }) => void | Promise<void>;
  onRuntimeCreate?: (
    session: ManagedSession<E, TTurnInput, TSummary>,
  ) => void | Promise<void>;
  isQuiescent?: (sessionId: string) => boolean;
}

export interface SendTurnOptions<
  E extends SessionEventBase = SessionEventBase,
  TTurnInput = unknown,
  TSummary extends SessionSummaryBase = SessionSummaryBase,
> {
  dedupKey?: string;
  recoveryKey?: string;
  startDraft?: SessionEventDraft<E>;
  buildStartDraft?: (turn: number, input: unknown) => SessionEventDraft<E>;
  manageTurnEvents?: boolean;
  onTurnAdmitted?: (ctx: {
    runtime: ManagedSession<E, TTurnInput, TSummary>;
    turn: number;
  }) => Promise<void>;
}

export interface DeleteSessionOptions<E extends SessionEventBase = SessionEventBase> {
  beforeDelete?: (sessionId: string, events: readonly E[]) => Promise<void>;
}

/**
 * Coordinates resident {@link ManagedSession} runtimes over a
 * {@link SessionPersistencePort} and optional {@link SessionDriverPort}.
 */
export class SessionManager<
  E extends SessionEventBase = SessionEventBase,
  TSummary extends SessionSummaryBase = SessionSummaryBase,
  TTurnInput = unknown,
  TResult = void,
> {
  readonly persistence: SessionPersistencePort<E, TSummary>;
  readonly liveHub = new LiveStreamHub();

  private readonly driver?: SessionDriverPort<E, TTurnInput, TResult>;
  private readonly now: () => Date;
  private readonly idleTimeoutMs: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly peerGroup?: Set<SessionManager<any, any, any, any>>;
  private readonly onRecover?: SessionManagerOptions<E, TSummary, TTurnInput, TResult>['onRecover'];
  private readonly onRuntimeCreate?: SessionManagerOptions<E, TSummary, TTurnInput, TResult>['onRuntimeCreate'];
  private readonly isQuiescentExt?: (sessionId: string) => boolean;

  private readonly sessions = new Map<string, ManagedSession<E, TTurnInput, TSummary>>();
  private readonly timelineUnsubs = new Map<string, () => void>();
  private readonly ensuring = new Map<string, Promise<ManagedSession<E, TTurnInput, TSummary>>>();
  private readonly closingHandles = new Map<string, Promise<void>>();
  private readonly pendingAdmissions = new Map<string, number>();
  private readonly deletedSessions = new Set<string>();
  private readonly pendingSends = new PendingSendLatch<{ turn: number }>();
  private readonly pipeline = new Set<Promise<unknown>>();
  private readonly idleSince = new Map<string, number>();

  private ready: Promise<void> | undefined;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private inboxSeq = 0;

  constructor(options: SessionManagerOptions<E, TSummary, TTurnInput, TResult> = {}) {
    this.persistence = options.persistence ?? new MemorySessionPersistence<E, TSummary>({
      now: options.now,
    });
    this.driver = options.driver;
    this.now = options.now ?? (() => new Date());
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.peerGroup = options.peerGroup;
    this.onRecover = options.onRecover;
    this.onRuntimeCreate = options.onRuntimeCreate;
    this.isQuiescentExt = options.isQuiescent;

    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (Number.isFinite(sweepIntervalMs) && sweepIntervalMs > 0) {
      const timer = setInterval(() => {
        void this.sweepIdleSessions();
      }, sweepIntervalMs);
      if (timer !== null && typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
        timer.unref();
      }
      this.idleTimer = timer;
    }

    this.peerGroup?.add(this);
  }

  init(): Promise<void> {
    if (this.ready === undefined) {
      this.ready = Promise.resolve(this.persistence.init?.());
    }
    return this.ready;
  }

  async createSession(
    sessionId: string,
    initialDrafts?: readonly SessionEventDraft<E>[],
    options?: { isSeed?: boolean },
  ): Promise<ManagedSession<E, TTurnInput, TSummary>> {
    this.assertOpen();
    this.beginAdmission(sessionId);
    let handle: SessionStorageHandle<E, TSummary> | undefined;
    try {
      await this.init();
      await this.awaitClosingHandle(sessionId);
      this.assertOpen();
      if (this.sessions.has(sessionId)) {
        throw new SessionAlreadyExistsError(sessionId);
      }
      handle = await this.persistence.create(sessionId, initialDrafts, options);
      this.deletedSessions.delete(sessionId);
      const runtime = new ManagedSession<E, TTurnInput, TSummary>({
        sessionId,
        handle,
        now: this.now,
      });
      this.bindRuntimeSync(sessionId, runtime);
      await this.onRuntimeCreate?.(runtime);
      this.assertOpen();
      this.sessions.set(sessionId, runtime);
      this.idleSince.delete(sessionId);
      return runtime;
    } catch (error) {
      if (this.sessions.get(sessionId)?.handle !== handle) {
        this.unbindRuntimeSync(sessionId);
      }
      if (handle !== undefined && this.sessions.get(sessionId)?.handle !== handle) {
        await handle.close().catch(() => undefined);
      }
      throw error;
    } finally {
      this.endAdmission(sessionId);
    }
  }

  async forkSession(
    sourceSessionId: string,
    newSessionId: string,
    upToSeq?: number,
  ): Promise<ManagedSession<E, TTurnInput, TSummary>> {
    this.assertOpen();
    await this.init();
    if (this.deletedSessions.has(sourceSessionId)) {
      throw new SessionNotFoundError(sourceSessionId);
    }
    const resident = this.sessions.get(sourceSessionId);
    if (resident === undefined && this.persistence.stat(sourceSessionId) === undefined) {
      throw new SessionNotFoundError(sourceSessionId);
    }
    const sourceEvents = resident !== undefined
      ? resident.read()
      : this.persistence.read(sourceSessionId);
    const { seed } = buildForkSeed(sourceEvents, upToSeq);
    return this.createSession(newSessionId, seed, { isSeed: true });
  }

  async ensureSession(sessionId: string): Promise<ManagedSession<E, TTurnInput, TSummary>> {
    this.assertOpen();
    await this.init();
    this.assertNotDeleted(sessionId);

    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;

    let pending = this.ensuring.get(sessionId);
    if (pending === undefined) {
      pending = this.recoverSession(sessionId).finally(() => {
        if (this.ensuring.get(sessionId) === pending) {
          this.ensuring.delete(sessionId);
        }
      });
      this.ensuring.set(sessionId, pending);
    }
    return pending;
  }

  getRuntime(sessionId: string): ManagedSession<E, TTurnInput, TSummary> | undefined {
    return this.sessions.get(sessionId);
  }

  async withAdmission<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.beginAdmission(sessionId);
    try {
      return await fn();
    } finally {
      this.endAdmission(sessionId);
    }
  }

  async sendTurn(
    sessionId: string,
    input: TTurnInput,
    options?: SendTurnOptions<E, TTurnInput, TSummary>,
  ): Promise<{ turn: number }> {
    this.assertOpen();
    if (options?.recoveryKey !== undefined) {
      const resident = this.sessions.get(sessionId);
      const waiting = resident?.recoveryWait.matches(options.recoveryKey);
      if (waiting !== undefined) {
        return { turn: waiting.turn };
      }
    }

    if (options?.dedupKey !== undefined) {
      const fingerprint = `${sessionId}\u0000${options.dedupKey}`;
      return this.pendingSends.run(fingerprint, () => this.admitTurn(sessionId, input, options));
    }

    return this.admitTurn(sessionId, input, options);
  }

  async steer(
    sessionId: string,
    input: TTurnInput,
    options?: { id?: string; appendDraft?: SessionEventDraft<E> },
  ): Promise<{ turn: number } | undefined> {
    this.assertOpen();
    const runtime = await this.ensureSession(sessionId);
    const running = findRunningTurn(runtime);
    if (running === undefined) return undefined;

    runtime.inbox.enqueue('steer', options?.id ?? this.nextInboxId(), input, this.now());
    if (options?.appendDraft !== undefined) {
      await runtime.append(options.appendDraft);
    } else {
      const text = extractTextField(input);
      if (text !== undefined) {
        await runtime.append({
          type: 'turn.steered',
          turn: running.turn,
          id: `t${running.turn}`,
          text,
        } as unknown as SessionEventDraft<E>);
      }
    }
    return { turn: running.turn };
  }

  async inject(
    sessionId: string,
    input: TTurnInput,
    options?: { id?: string },
  ): Promise<{ turn: number } | undefined> {
    this.assertOpen();
    const runtime = await this.ensureSession(sessionId);
    const running = findRunningTurn(runtime);
    if (running === undefined) return undefined;

    runtime.inbox.enqueue('inject', options?.id ?? this.nextInboxId(), input, this.now());
    return { turn: running.turn };
  }

  async interruptTurn(
    sessionId: string,
    turn: number,
    reason: 'user' | 'shutdown' | 'restart' = 'user',
  ): Promise<void> {
    this.assertOpen();
    const owner = this.interruptOwner(sessionId);
    if (owner !== this) {
      await owner.interruptTurn(sessionId, turn, reason);
      return;
    }
    const operation = this.performInterruptTurn(sessionId, turn, reason);
    this.track(operation);
    await operation;
  }

  activeTurnCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      count += session.activeTurnCount();
    }
    return count;
  }

  hasRunningTurns(): boolean {
    return this.activeTurnCount() > 0;
  }

  read(sessionId: string): E[] {
    this.assertNotDeleted(sessionId);
    const runtime = this.sessions.get(sessionId);
    if (runtime !== undefined) return runtime.read();
    return this.persistence.read(sessionId);
  }

  readPage(sessionId: string, afterSeq: number, limit: number): SessionPage<E> {
    this.assertNotDeleted(sessionId);
    const runtime = this.sessions.get(sessionId);
    if (runtime !== undefined) return runtime.readPage(afterSeq, limit);
    if (this.persistence.readPage !== undefined) {
      return this.persistence.readPage(sessionId, afterSeq, limit);
    }
    const events = this.persistence.read(sessionId);
    if (events.length === 0 && this.persistence.stat(sessionId) === undefined) {
      throw new SessionNotFoundError(sessionId);
    }
    return pageEvents(events, afterSeq, limit);
  }

  async append(sessionId: string, draft: SessionEventDraft<E>): Promise<E> {
    this.assertOpen();
    await this.init();
    const runtime = await this.ensureSession(sessionId);
    return runtime.append(draft);
  }

  listSessions(): TSummary[] {
    return this.persistence.list().map((summary) => ({
      ...summary,
      running: this.sessionHasRunningTurns(summary.sessionId),
    }));
  }

  subscribe(sessionId: string, listener: (event: E) => void): () => void {
    return this.persistence.subscribe(sessionId, listener);
  }

  readLive(sessionId: string): LiveFrame[] {
    return this.liveHub.read(sessionId);
  }

  subscribeLive(sessionId: string, listener: (frames: LiveFrame[]) => void): () => void {
    return this.liveHub.subscribe(sessionId, listener);
  }

  async deleteSession(
    sessionId: string,
    options?: DeleteSessionOptions<E>,
  ): Promise<void> {
    this.assertOpen();
    await this.init();

    if ((this.pendingAdmissions.get(sessionId) ?? 0) > 0) {
      throw new SessionBusyError(
        sessionId,
        `Cannot delete a session while an admission is pending: ${sessionId}`,
      );
    }
    if (this.ensuring.has(sessionId)) {
      throw new SessionBusyError(
        sessionId,
        `Cannot delete a session while recovery is pending: ${sessionId}`,
      );
    }

    const runtime = this.sessions.get(sessionId);
    if (runtime !== undefined) {
      for (const turn of runtime.turns.values()) {
        if (!turn.durableTerminal || turn.hasLateWork()) {
          throw new SessionBusyError(
            sessionId,
            `Cannot delete a session with a running turn: ${sessionId}`,
          );
        }
      }
      if (!runtime.isQuiescent() && runtime.hasRunningTurns()) {
        throw new SessionBusyError(
          sessionId,
          `Cannot delete a session with active work: ${sessionId}`,
        );
      }
    }

    const known = runtime !== undefined || this.persistence.stat(sessionId) !== undefined;
    if (!known) {
      throw new SessionNotFoundError(sessionId);
    }

    const events = options?.beforeDelete !== undefined
      ? (runtime !== undefined ? runtime.read() : this.persistence.read(sessionId))
      : [];

    this.deletedSessions.add(sessionId);
    try {
      if (runtime !== undefined) {
        this.sessions.delete(sessionId);
        this.idleSince.delete(sessionId);
        await this.closeSessionHandle(sessionId, runtime);
      } else {
        this.unbindRuntimeSync(sessionId);
      }
      await options?.beforeDelete?.(sessionId, events);
      await this.persistence.deleteSession(sessionId);
    } catch (error) {
      this.deletedSessions.delete(sessionId);
      throw error;
    }
    this.ensuring.delete(sessionId);
    this.liveHub.drop(sessionId);
  }

  async flush(): Promise<void> {
    this.assertOpen();
    await this.init();
    while (this.pipeline.size > 0) {
      await Promise.allSettled([...this.pipeline]);
    }
    for (const session of this.sessions.values()) {
      await session.flush();
    }
    await this.persistence.flush?.();
  }

  async sweepIdleSessions(): Promise<void> {
    if (this.closed) return;
    const nowMs = this.now().getTime();
    const toClose: Array<Promise<void>> = [];

    for (const [sessionId, session] of [...this.sessions]) {
      if (!this.isSessionQuiescent(sessionId, session)) {
        this.idleSince.delete(sessionId);
        continue;
      }
      const since = this.idleSince.get(sessionId);
      if (since === undefined) {
        this.idleSince.set(sessionId, nowMs);
        continue;
      }
      if (nowMs - since < this.idleTimeoutMs) continue;
      if (this.sessions.get(sessionId) !== session || !this.isSessionQuiescent(sessionId, session)) {
        this.idleSince.delete(sessionId);
        continue;
      }
      this.sessions.delete(sessionId);
      this.idleSince.delete(sessionId);
      toClose.push(this.closeSessionHandle(sessionId, session));
    }

    this.pruneDeletedSessions();
    if (toClose.length > 0) {
      await Promise.allSettled(toClose);
    }
  }

  close(): Promise<void> {
    if (this.closePromise === undefined) {
      this.closePromise = this.doClose();
    }
    return this.closePromise;
  }

  /** Used by peer managers in {@link peerGroup} to route cross-manager interrupts. */
  ownsSession(sessionId: string): boolean {
    if (this.deletedSessions.has(sessionId)) return true;
    if (this.sessions.has(sessionId)) return true;
    return this.persistence.stat(sessionId) !== undefined;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    if (this.idleTimer !== undefined) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.idleSince.clear();
    await (this.ready?.catch(() => undefined) ?? Promise.resolve());

    for (const [sessionId, session] of [...this.sessions]) {
      for (const turn of [...session.turns.values()]) {
        if (!turn.finished) {
          await this.performInterruptTurn(sessionId, turn.turn, 'shutdown').catch(() => undefined);
        } else if (!turn.abort.signal.aborted) {
          turn.abort.abort();
        }
      }
    }

    while (this.pipeline.size > 0) {
      await Promise.allSettled([...this.pipeline]);
    }

    await Promise.allSettled([...this.closingHandles.values()]);
    for (const [sessionId, session] of [...this.sessions]) {
      this.unbindRuntimeSync(sessionId);
      this.sessions.delete(sessionId);
      await session.close().catch(() => undefined);
    }
    for (const sessionId of [...this.timelineUnsubs.keys()]) {
      this.unbindRuntimeSync(sessionId);
    }
    this.liveHub.clear();
    this.peerGroup?.delete(this);
    await this.persistence.close();
  }

  private async recoverSession(sessionId: string): Promise<ManagedSession<E, TTurnInput, TSummary>> {
    await this.awaitClosingHandle(sessionId);
    this.assertNotDeleted(sessionId);
    const handle = await this.persistence.open(sessionId, 'write');
    try {
      this.assertOpen();
      this.assertNotDeleted(sessionId);
      const events = handle.read();
      const repair = analyzeTailRepair(events, { reason: 'shutdown' });
      if (repair.hasDanglingWork) {
        await this.onRecover?.({ sessionId, events, repair });
        await this.driver?.recoverSession?.({ sessionId, events, repair });
        for (const draft of repair.drafts) {
          await handle.append(draft);
        }
      }
      const runtime = new ManagedSession<E, TTurnInput, TSummary>({
        sessionId,
        handle,
        now: this.now,
      });
      this.bindRuntimeSync(sessionId, runtime);
      await this.onRuntimeCreate?.(runtime);
      this.assertOpen();
      this.assertNotDeleted(sessionId);
      this.sessions.set(sessionId, runtime);
      this.idleSince.delete(sessionId);
      return runtime;
    } catch (error) {
      if (this.sessions.get(sessionId)?.handle !== handle) {
        this.unbindRuntimeSync(sessionId);
      }
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async admitTurn(
    sessionId: string,
    input: TTurnInput,
    options?: SendTurnOptions<E, TTurnInput, TSummary>,
  ): Promise<{ turn: number }> {
    this.beginAdmission(sessionId);
    try {
      const runtime = await this.ensureSession(sessionId);
      this.assertOpen();
      this.assertNotDeleted(sessionId);

      const turnNumber = runtime.nextTurn;
      const record = runtime.createTurn(turnNumber, input);
      const manageTurnEvents = options?.manageTurnEvents !== false;

      if (manageTurnEvents) {
        const startDraft = options?.buildStartDraft?.(turnNumber, input)
          ?? options?.startDraft
          ?? buildDefaultTurnStartDraft<E>(turnNumber, input);
        try {
          await runtime.append(startDraft);
        } catch (error) {
          runtime.turns.delete(turnNumber);
          if (runtime.nextTurn === turnNumber + 1) {
            runtime.nextTurn = turnNumber;
          }
          throw error;
        }
      }

      if (options?.onTurnAdmitted !== undefined) {
        try {
          await options.onTurnAdmitted({ runtime, turn: turnNumber });
        } catch (error) {
          record.finished = true;
          record.status = 'failed';
          record.error = error;
          if (manageTurnEvents && !hasTurnFinishedEvent(runtime.read(), turnNumber)) {
            const message = error instanceof Error ? error.message : String(error);
            await runtime.append({
              type: 'turn.finished',
              turn: turnNumber,
              id: `t${turnNumber}`,
              status: 'failed',
              error: message,
            } as unknown as SessionEventDraft<E>).catch(() => undefined);
          }
          runtime.markTurnDurableTerminal(turnNumber, 'failed', error);
          throw error;
        }
      }

      let released = false;
      let execPromise!: Promise<void>;
      const releasePipeline = (): void => {
        released = true;
        this.pipeline.delete(execPromise);
      };
      execPromise = this.executeTurn(runtime, record, manageTurnEvents, releasePipeline);
      if (!released) {
        this.track(execPromise);
      }
      return { turn: turnNumber };
    } finally {
      this.endAdmission(sessionId);
    }
  }

  private async executeTurn(
    runtime: ManagedSession<E, TTurnInput, TSummary>,
    record: ReturnType<ManagedSession<E, TTurnInput, TSummary>['createTurn']>,
    manageTurnEvents: boolean,
    onReleasePipeline: () => void,
  ): Promise<void> {
    const turn = record.turn;
    try {
      if (this.driver !== undefined) {
        const ctx: SessionDriverContext<E, TTurnInput> = {
          sessionId: runtime.sessionId,
          turn,
          input: record.input,
          signal: record.abort.signal,
          read: () => runtime.read(),
          append: (draft) => runtime.append(draft),
          flush: () => runtime.flush(),
          project: (projector) => runtime.project(projector),
        };
        await this.driver.runTurn(ctx);
      }

      if (record.finished) {
        onReleasePipeline();
        return;
      }
      record.finished = true;
      const status: 'completed' | 'interrupted' = record.abort.signal.aborted
        ? 'interrupted'
        : 'completed';
      record.status = status;
      await record.awaitLateWork();
      if (manageTurnEvents && !hasTurnFinishedEvent(runtime.read(), turn)) {
        await runtime.append({
          type: 'turn.finished',
          turn,
          id: `t${turn}`,
          status,
        } as unknown as SessionEventDraft<E>);
      }
      onReleasePipeline();
      runtime.markTurnDurableTerminal(turn, status);
    } catch (error) {
      if (record.finished) {
        onReleasePipeline();
        return;
      }
      record.finished = true;
      const status: 'failed' | 'interrupted' = record.abort.signal.aborted
        ? 'interrupted'
        : 'failed';
      record.status = status;
      record.error = error;
      await record.awaitLateWork().catch(() => undefined);
      if (manageTurnEvents && !hasTurnFinishedEvent(runtime.read(), turn)) {
        const message = error instanceof Error ? error.message : String(error);
        await runtime.append({
          type: 'turn.finished',
          turn,
          id: `t${turn}`,
          status,
          ...(status === 'failed' ? { error: message } : {}),
        } as unknown as SessionEventDraft<E>).catch(() => undefined);
      }
      onReleasePipeline();
      runtime.markTurnDurableTerminal(turn, status, error);
    }
  }

  private async performInterruptTurn(
    sessionId: string,
    turn: number,
    reason: 'user' | 'shutdown' | 'restart',
  ): Promise<void> {
    const runtime = await this.ensureSession(sessionId);
    const record = runtime.turns.get(turn);
    if (record === undefined || record.finished) return;

    record.finished = true;
    record.status = 'interrupted';
    runtime.inbox.clearOnInterrupt(reason === 'user');
    record.abort.abort();

    try {
      await runtime.append({
        type: 'turn.interrupted',
        turn,
        parent: `t${turn}`,
        reason,
      } as unknown as SessionEventDraft<E>);
      await this.driver?.interruptTurn?.({ sessionId, turn, reason });
      await record.awaitLateWork();
      if (!hasTurnFinishedEvent(runtime.read(), turn)) {
        await runtime.append({
          type: 'turn.finished',
          turn,
          id: `t${turn}`,
          status: 'interrupted',
        } as unknown as SessionEventDraft<E>);
      }
    } finally {
      runtime.markTurnDurableTerminal(turn, 'interrupted');
    }
  }

  private interruptOwner(
    sessionId: string,
  ): SessionManager<E, TSummary, TTurnInput, TResult> {
    if (this.ownsSession(sessionId)) return this;
    if (this.peerGroup !== undefined) {
      for (const peer of this.peerGroup) {
        if (peer === this || peer.closed) continue;
        if (peer.ownsSession(sessionId)) {
          return peer as SessionManager<E, TSummary, TTurnInput, TResult>;
        }
      }
    }
    return this;
  }

  private sessionHasRunningTurns(sessionId: string): boolean {
    const runtime = this.sessions.get(sessionId);
    return runtime !== undefined ? runtime.hasRunningTurns() : false;
  }

  private isSessionQuiescent(
    sessionId: string,
    session: ManagedSession<E, TTurnInput, TSummary>,
  ): boolean {
    if (this.pipeline.size > 0) return false;
    if (this.ensuring.has(sessionId)) return false;
    if (this.pendingSends.hasPrefix(`${sessionId}\u0000`)) return false;
    if ((this.pendingAdmissions.get(sessionId) ?? 0) > 0) return false;
    if (this.liveHub.read(sessionId).length > 0) return false;
    if (this.isQuiescentExt !== undefined && !this.isQuiescentExt(sessionId)) return false;
    return session.isQuiescent();
  }

  private pruneDeletedSessions(): void {
    for (const sessionId of [...this.deletedSessions]) {
      if (this.pendingSends.hasPrefix(`${sessionId}\u0000`)) continue;
      if (this.ensuring.has(sessionId)) continue;
      if ((this.pendingAdmissions.get(sessionId) ?? 0) > 0) continue;
      this.deletedSessions.delete(sessionId);
    }
  }

  private closeSessionHandle(
    sessionId: string,
    session: ManagedSession<E, TTurnInput, TSummary>,
  ): Promise<void> {
    this.unbindRuntimeSync(sessionId);
    const prev = this.closingHandles.get(sessionId);
    const closing = (prev ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => session.close())
      .finally(() => {
        if (this.closingHandles.get(sessionId) === closing) {
          this.closingHandles.delete(sessionId);
        }
      });
    this.closingHandles.set(sessionId, closing);
    return closing;
  }

  private async awaitClosingHandle(sessionId: string): Promise<void> {
    const closing = this.closingHandles.get(sessionId);
    if (closing !== undefined) {
      await closing.catch(() => undefined);
    }
  }

  private bindRuntimeSync(
    sessionId: string,
    runtime: ManagedSession<E, TTurnInput, TSummary>,
  ): void {
    this.unbindRuntimeSync(sessionId);
    const unsubscribe = this.persistence.subscribe(sessionId, (event) => {
      if (event.seq === runtime.timeline.lastSeq + 1) {
        runtime.timeline.commit(event);
      } else if (event.seq > runtime.timeline.lastSeq + 1) {
        runtime.timeline.reset(runtime.handle.read());
      }
    });
    this.timelineUnsubs.set(sessionId, unsubscribe);
  }

  private unbindRuntimeSync(sessionId: string): void {
    const unsubscribe = this.timelineUnsubs.get(sessionId);
    if (unsubscribe === undefined) return;
    this.timelineUnsubs.delete(sessionId);
    unsubscribe();
  }

  private track(promise: Promise<unknown>): void {
    this.pipeline.add(promise);
    const cleanup = (): void => {
      this.pipeline.delete(promise);
    };
    void promise.then(cleanup, cleanup);
  }

  private beginAdmission(sessionId: string): void {
    this.pendingAdmissions.set(sessionId, (this.pendingAdmissions.get(sessionId) ?? 0) + 1);
  }

  private endAdmission(sessionId: string): void {
    const remaining = (this.pendingAdmissions.get(sessionId) ?? 1) - 1;
    if (remaining <= 0) this.pendingAdmissions.delete(sessionId);
    else this.pendingAdmissions.set(sessionId, remaining);
  }

  private assertOpen(): void {
    if (this.closed) throw new SessionClosedError();
  }

  private assertNotDeleted(sessionId: string): void {
    if (this.deletedSessions.has(sessionId)) {
      throw new SessionNotFoundError(sessionId);
    }
  }

  private nextInboxId(): string {
    this.inboxSeq += 1;
    return `in_${this.inboxSeq}`;
  }
}

export function createSessionManager<
  E extends SessionEventBase = SessionEventBase,
  TSummary extends SessionSummaryBase = SessionSummaryBase,
  TTurnInput = unknown,
  TResult = void,
>(
  options?: SessionManagerOptions<E, TSummary, TTurnInput, TResult>,
): SessionManager<E, TSummary, TTurnInput, TResult> {
  return new SessionManager<E, TSummary, TTurnInput, TResult>(options);
}

function findRunningTurn<
  E extends SessionEventBase,
  TTurnInput,
  TSummary extends SessionSummaryBase,
>(
  runtime: ManagedSession<E, TTurnInput, TSummary>,
): ReturnType<ManagedSession<E, TTurnInput, TSummary>['createTurn']> | undefined {
  for (const turn of runtime.turns.values()) {
    if (!turn.durableTerminal && !turn.finished) return turn;
  }
  return undefined;
}

function buildDefaultTurnStartDraft<E extends SessionEventBase>(
  turn: number,
  input: unknown,
): SessionEventDraft<E> {
  const text = extractTextField(input);
  return {
    type: 'turn.started',
    turn,
    id: `t${turn}`,
    ...(text === undefined ? {} : { text }),
  } as unknown as SessionEventDraft<E>;
}

function extractTextField(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (input !== null && typeof input === 'object') {
    const rec = input as Record<string, unknown>;
    if (typeof rec.text === 'string') return rec.text;
  }
  return undefined;
}

function hasTurnFinishedEvent<E extends SessionEventBase>(
  events: readonly E[],
  turn: number,
): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'turn.finished' && event.turn === turn) return true;
  }
  return false;
}
