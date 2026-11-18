import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LedgerEvent, LedgerEventDraft, SessionSummary } from '@wrenyard/protocol/session';
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionClosedError,
  SessionCorruptedError,
  SessionNotFoundError,
  pageEvents,
  snapshotJsonValue,
  type SessionPage,
  type SessionPersistencePort,
  type SessionStorageHandle,
  type SessionStorageMode,
} from '@wrenyard/session';
import { normalizeStoredEvent, stepId, turnId } from './compat.ts';
import { JsonlStorageHandle, type JsonlStorageBackend } from './handle.ts';
import {
  DEFAULT_TITLE,
  INDEX_WRITE_DEBOUNCE_MS,
  SESSION_ID_PATTERN,
  SessionIndexStore,
  assertSessionId,
  failedSpanFacts,
  isLifecycleEvent,
  lastTurnAfter,
  pendingTurnsAfter,
  pendingTurnsOf,
  readSummary,
  summarize,
  type FailedSpanFacts,
} from './index-store.ts';
import {
  MAX_CACHED_BYTES,
  MAX_CACHED_EVENTS,
  MAX_CACHED_SESSIONS,
  SessionLruCache,
  type LoadedSession,
} from './lru-cache.ts';

export {
  DEFAULT_TITLE,
  INDEX_WRITE_DEBOUNCE_MS,
  MAX_CACHED_BYTES,
  MAX_CACHED_EVENTS,
  MAX_CACHED_SESSIONS,
  SESSION_ID_PATTERN,
  JsonlStorageHandle,
  SessionIndexStore,
  SessionLruCache,
  assertSessionId,
  failedSpanFacts,
  isLifecycleEvent,
  lastTurnAfter,
  normalizeStoredEvent,
  pendingTurnsAfter,
  pendingTurnsOf,
  readSummary,
  stepId,
  summarize,
  turnId,
};
export type { FailedSpanFacts, LoadedSession };

export interface BeforeAppendContext {
  sessionId: string;
  events: readonly LedgerEvent[];
  draft: LedgerEventDraft;
  fromExclusive?: boolean;
  isSeed?: boolean;
}

export type BeforeAppendResult =
  | { action: 'append'; draft: LedgerEventDraft }
  | { action: 'return-existing'; event: LedgerEvent };

export type BeforeAppendHook = (ctx: BeforeAppendContext) => BeforeAppendResult;

export interface JsonlPersistenceOptions {
  stateRoot: string;
  workspaceRoot: string;
  now?: () => Date;
  beforeAppend?: BeforeAppendHook;
}

export function createJsonlPersistence(
  options: JsonlPersistenceOptions,
): JsonlSessionPersistence {
  return new JsonlSessionPersistence(options);
}

/**
 * Durable JSONL + fsync + index.json implementation of
 * {@link SessionPersistencePort} for Wrenyard session timelines.
 */
export class JsonlSessionPersistence
  implements SessionPersistencePort<LedgerEvent, SessionSummary>, JsonlStorageBackend
{
  readonly rootDir: string;
  private readonly now: () => Date;
  private readonly sessionsDir: string;
  private readonly indexPath: string;
  private readonly index: SessionIndexStore;
  private readonly cache = new SessionLruCache();
  private readonly writers = new Map<string, JsonlStorageHandle>();
  private readonly handles = new Map<string, Set<JsonlStorageHandle>>();
  private readonly listeners = new Map<string, Set<(event: LedgerEvent) => void>>();
  private beforeAppend?: BeforeAppendHook;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: JsonlPersistenceOptions) {
    this.now = options.now ?? (() => new Date());
    this.beforeAppend = options.beforeAppend;
    const digest = createHash('sha256').update(options.workspaceRoot, 'utf8').digest('hex');
    this.rootDir = join(options.stateRoot, 'session', digest);
    this.sessionsDir = join(this.rootDir, 'sessions');
    this.indexPath = join(this.rootDir, 'index.json');
    mkdirSync(this.sessionsDir, { recursive: true });
    this.index = new SessionIndexStore(this.sessionsDir, this.indexPath);
    this.index.loadIndexSync();
    this.index.reconcileIndexSync();
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  setBeforeAppendHook(hook: BeforeAppendHook | undefined): void {
    this.beforeAppend = hook;
  }

  enqueueExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async create(
    sessionId: string,
    initialDrafts?: readonly LedgerEventDraft[],
    options?: { isSeed?: boolean },
  ): Promise<SessionStorageHandle<LedgerEvent, SessionSummary>> {
    this.assertOpen();
    assertSessionId(sessionId);
    return this.enqueueExclusive(async () => {
      this.assertOpen();
      const file = this.sessionFile(sessionId);
      if (existsSync(file) || this.index.has(sessionId)) {
        throw new SessionAlreadyExistsError(sessionId);
      }
      if (this.writers.has(sessionId)) {
        throw new SessionAlreadyOwnedError(sessionId);
      }

      writeFileSync(file, '', 'utf8');
      const createdAt = this.now().toISOString();
      this.index.set(sessionId, {
        sessionId,
        title: DEFAULT_TITLE,
        createdAt,
        updatedAt: createdAt,
        lastSeq: 0,
        pendingTurns: [],
        bytes: 0,
      });

      const handle = this.createHandle(sessionId, 'write');
      try {
        if (initialDrafts !== undefined && initialDrafts.length > 0) {
          await this.appendBatchNow(sessionId, initialDrafts, false, options?.isSeed === true);
        }
        await this.index.flushIndex();
        return handle;
      } catch (error) {
        handle.forceClose();
        this.cache.drop(sessionId);
        this.index.delete(sessionId);
        await rm(file, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async open(
    sessionId: string,
    mode: SessionStorageMode,
  ): Promise<SessionStorageHandle<LedgerEvent, SessionSummary>> {
    this.assertOpen();
    assertSessionId(sessionId);
    if (mode === 'write' && this.writers.has(sessionId)) {
      throw new SessionAlreadyOwnedError(sessionId);
    }
    return this.enqueueExclusive(async () => {
      this.assertOpen();
      if (!existsSync(this.sessionFile(sessionId))) {
        throw new SessionNotFoundError(sessionId);
      }
      if (mode === 'write' && this.writers.has(sessionId)) {
        throw new SessionAlreadyOwnedError(sessionId);
      }
      return this.createHandle(sessionId, mode);
    });
  }

  stat(sessionId: string): SessionSummary | undefined {
    assertSessionId(sessionId);
    return this.index.get(sessionId);
  }

  list(): SessionSummary[] {
    return this.index.list();
  }

  read(sessionId: string): LedgerEvent[] {
    assertSessionId(sessionId);
    return [...this.loadSessionSync(sessionId)];
  }

  readPage(sessionId: string, afterSeq: number, limit: number): SessionPage<LedgerEvent> {
    assertSessionId(sessionId);
    const cached = this.cache.get(sessionId);
    if (cached !== undefined) {
      return pageEvents(cached.events, afterSeq, limit);
    }
    if (!existsSync(this.sessionFile(sessionId))) {
      throw new SessionNotFoundError(sessionId);
    }
    const summary = this.index.get(sessionId);
    if (
      summary !== undefined
      && !this.index.isStale(sessionId)
      && summary.lastSeq !== undefined
      && afterSeq >= summary.lastSeq
    ) {
      return { events: [], lastSeq: summary.lastSeq, hasMore: false };
    }
    const events = this.loadSessionSync(sessionId);
    return pageEvents(events, afterSeq, limit);
  }

  subscribe(sessionId: string, listener: (event: LedgerEvent) => void): () => void {
    assertSessionId(sessionId);
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
    assertSessionId(sessionId);
    return this.enqueueExclusive(async () => {
      this.assertOpen();
      const file = this.sessionFile(sessionId);
      const known = this.index.has(sessionId) || this.cache.has(sessionId) || existsSync(file);
      if (!known) {
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
      this.cache.drop(sessionId);
      this.index.delete(sessionId);
      const listeners = this.listeners.get(sessionId);
      if (listeners !== undefined) {
        listeners.clear();
        this.listeners.delete(sessionId);
      }
      await rm(file, { force: true });
      await this.index.flushIndex();
    });
  }

  async flush(): Promise<void> {
    this.assertOpen();
    await this.queue.catch(() => undefined);
    await this.index.flushIndex();
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
    this.index.cancelIndexTimer();
    await this.index.flushIndex().catch(() => undefined);
    this.listeners.clear();
    this.cache.clear();
  }

  appendDirect(
    sessionId: string,
    draft: LedgerEventDraft,
    options?: { fromExclusive?: boolean },
  ): Promise<LedgerEvent> {
    this.assertOpen();
    if (options?.fromExclusive === true) {
      return this.appendNow(sessionId, draft, true);
    }
    return this.enqueueExclusive(() => this.appendNow(sessionId, draft, false));
  }

  appendBatchDirect(
    sessionId: string,
    drafts: readonly LedgerEventDraft[],
    options?: { fromExclusive?: boolean },
  ): Promise<LedgerEvent[]> {
    this.assertOpen();
    if (options?.fromExclusive === true) {
      return this.appendBatchNow(sessionId, drafts, true);
    }
    return this.enqueueExclusive(() => this.appendBatchNow(sessionId, drafts, false));
  }

  async syncSessionFile(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    const handle = await open(this.sessionFile(sessionId), 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async appendNow(
    sessionId: string,
    draft: LedgerEventDraft,
    fromExclusive: boolean,
  ): Promise<LedgerEvent> {
    assertSessionId(sessionId);
    this.cache.pin(sessionId);
    try {
      const events = this.loadSessionSync(sessionId);
      let activeDraft = draft;
      if (this.beforeAppend !== undefined) {
        const decision = this.beforeAppend({
          sessionId,
          events,
          draft: activeDraft,
          fromExclusive,
          isSeed: false,
        });
        if (decision.action === 'return-existing') {
          return decision.event;
        }
        activeDraft = decision.draft;
      }

      const previousSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
      const event = snapshotJsonValue({
        ...(activeDraft as Record<string, unknown>),
        seq: previousSeq + 1,
        at: this.now().toISOString(),
      }) as unknown as LedgerEvent;

      const line = `${JSON.stringify(event)}\n`;
      const lineBytes = Buffer.byteLength(line, 'utf8');
      await appendLines(this.sessionFile(sessionId), line);
      events.push(event);
      this.cache.updateBytes(sessionId, lineBytes, 1, events);
      const previousBytes = this.index.get(sessionId)?.bytes ?? 0;
      this.index.applySummary(sessionId, event, events, previousBytes + lineBytes);
      if (isLifecycleEvent(event)) {
        await this.index.flushIndex();
      } else {
        this.index.scheduleIndexWrite();
      }
      this.emit(sessionId, event);
      return event;
    } catch (error) {
      this.cache.drop(sessionId);
      this.index.markStale(sessionId);
      throw error;
    } finally {
      this.cache.unpin(sessionId);
    }
  }

  private async appendBatchNow(
    sessionId: string,
    drafts: readonly LedgerEventDraft[],
    fromExclusive: boolean,
    isSeed = false,
  ): Promise<LedgerEvent[]> {
    assertSessionId(sessionId);
    if (drafts.length === 0) return [];
    this.cache.pin(sessionId);
    try {
      const events = this.loadSessionSync(sessionId);
      const stagedEvents: LedgerEvent[] = [];
      const stagedBytes: number[] = [];
      const results: LedgerEvent[] = [];
      const lines: string[] = [];
      let nextSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;

      for (const rawDraft of drafts) {
        let activeDraft = rawDraft;
        if (this.beforeAppend !== undefined) {
          const view = stagedEvents.length === 0 ? events : [...events, ...stagedEvents];
          const decision = this.beforeAppend({
            sessionId,
            events: view,
            draft: activeDraft,
            fromExclusive,
            isSeed,
          });
          if (decision.action === 'return-existing') {
            results.push(decision.event);
            continue;
          }
          activeDraft = decision.draft;
        }
        nextSeq += 1;
        const event = snapshotJsonValue({
          ...(activeDraft as Record<string, unknown>),
          seq: nextSeq,
          at: this.now().toISOString(),
        }) as unknown as LedgerEvent;
        const line = `${JSON.stringify(event)}\n`;
        lines.push(line);
        stagedEvents.push(event);
        stagedBytes.push(Buffer.byteLength(line, 'utf8'));
        results.push(event);
      }

      if (lines.length === 0) {
        return results;
      }

      const totalAddedBytes = stagedBytes.reduce((sum, n) => sum + n, 0);
      await appendLines(this.sessionFile(sessionId), lines.join(''));
      for (const event of stagedEvents) {
        events.push(event);
      }
      this.cache.updateBytes(sessionId, totalAddedBytes, stagedEvents.length, events);

      let runningBytes = this.index.get(sessionId)?.bytes ?? 0;
      let needsFlush = false;
      for (let index = 0; index < stagedEvents.length; index += 1) {
        const event = stagedEvents[index]!;
        runningBytes += stagedBytes[index]!;
        this.index.applySummary(sessionId, event, events, runningBytes);
        if (isLifecycleEvent(event)) needsFlush = true;
      }
      if (needsFlush) {
        await this.index.flushIndex();
      } else {
        this.index.scheduleIndexWrite();
      }
      for (const event of stagedEvents) {
        this.emit(sessionId, event);
      }
      return results;
    } catch (error) {
      this.cache.drop(sessionId);
      this.index.markStale(sessionId);
      throw error;
    } finally {
      this.cache.unpin(sessionId);
    }
  }

  private createHandle(
    sessionId: string,
    mode: SessionStorageMode,
  ): JsonlStorageHandle {
    let set = this.handles.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.handles.set(sessionId, set);
    }
    const handle = new JsonlStorageHandle(sessionId, mode, this, () => {
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

  private loadSessionSync(sessionId: string): LedgerEvent[] {
    const cached = this.cache.get(sessionId);
    if (cached !== undefined) {
      return cached.events;
    }
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) {
      return [];
    }
    const buffer = readFileSync(file);
    let bytes = buffer.length;
    const parsed = parseSessionFile(buffer, file);
    if (parsed.tornFrom !== undefined) {
      truncateSync(file, parsed.tornFrom);
      bytes = parsed.tornFrom;
    }
    const events = parsed.events.map((event) => deepFreeze(event));
    this.index.rebuildSummaryIfNeeded(sessionId, events, bytes);
    this.cache.set(sessionId, events, bytes);
    return events;
  }

  private emit(sessionId: string, event: LedgerEvent): void {
    const set = this.listeners.get(sessionId);
    if (set === undefined) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // A listener must never break the append queue.
      }
    }
  }

  private sessionFile(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  private assertOpen(): void {
    if (this.closed) throw new SessionClosedError();
  }
}

function parseSessionFile(
  buffer: Buffer,
  file: string,
): { events: LedgerEvent[]; tornFrom?: number } {
  const events: LedgerEvent[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    const offset = start;
    const line = buffer.subarray(offset, index).toString('utf8').replace(/\r$/u, '');
    start = index + 1;
    if (line.trim() === '') continue;
    events.push(normalizeStoredEvent(parseEventLine(line, file, offset)));
  }
  return { events, ...(start < buffer.length ? { tornFrom: start } : {}) };
}

function parseEventLine(line: string, file: string, offset: number): LedgerEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new SessionCorruptedError(
      `session ledger is corrupt at ${file} byte ${offset}; refusing to discard it`,
      { cause: error },
    );
  }
  if (
    value === null
    || typeof value !== 'object'
    || typeof (value as Record<string, unknown>).seq !== 'number'
    || typeof (value as Record<string, unknown>).at !== 'string'
    || typeof (value as Record<string, unknown>).type !== 'string'
  ) {
    throw new SessionCorruptedError(
      `session ledger has an invalid event at ${file} byte ${offset}`,
    );
  }
  return value as LedgerEvent;
}

async function appendLines(file: string, data: string): Promise<void> {
  const handle = await open(file, 'a');
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
