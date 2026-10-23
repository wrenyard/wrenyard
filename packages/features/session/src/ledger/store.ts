/**
 * session ledger: the append-only timeline and the state derived from it.
 *
 * The ledger is the only durable state of a session. Under
 * `<stateRoot>/session/<sha256(workspaceRoot)>/` it keeps
 *
 *   sessions/<sessionId>.jsonl  one event per line, appended durably (`fsync`)
 *   index.json                  the session list, derived from the timelines
 *
 * All appends in the process go through one serialized queue, so `seq` strictly
 * increases per session. Events are deep-frozen on the way in and the stored
 * arrays are copied out, so callers can never mutate timeline state.
 *
 * Startup reads only the index and the session directory's file metadata: no
 * JSONL body is parsed until a caller first reads or appends to that session.
 * A summary rebuilt from a body (or derived from the file's size when the index
 * is missing or behind) replaces the metadata entry on first touch.
 *
 * The JSONL reader tolerates exactly one thing: a torn final line (a trailing
 * fragment with no closing newline). It truncates that fragment before any
 * further append. Any other malformed line is corruption and throws instead of
 * being silently discarded.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionFile } from '@wrenyard/protocol';
import type { SessionSummary } from '@wrenyard/protocol/session';
import type { LedgerEvent, LedgerEventDraft } from './events.ts';
import { normalizeStoredEvent } from './compat.ts';
import { DocumentCommitter, type DocumentCommit } from '../document-commit.ts';
import { contentVersion, currentDocument, documentChange } from '../documents.ts';

// ─── Event model ───────────────────────────────────────────────────────────

/**
 * The append-only event model lives in `./ledger/events.ts`; the ledger
 * re-exports it so every `./ledger.ts` consumer keeps importing the same names.
 */
export * from './events.ts';

/**
 * The index row shape is part of the `session.list` wire contract, so it is
 * declared in `@wrenyard/protocol/session` and re-exported here.
 */
export type { SessionSummary };

// ─── Ledger ────────────────────────────────────────────────────────────────

const DEFAULT_TITLE = '新会话';
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Cache bounds for loaded timelines. A body is parsed only on first read or
 * append, and loaded bodies are kept in access order (oldest first) so the
 * least recently used one is evicted first. The three caps bound resident
 * sessions, their serialized bytes and their event count together. A single
 * session that is larger than any cap is never retained after the call that
 * loaded it.
 */
const MAX_CACHED_SESSIONS = 16;
const MAX_CACHED_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_EVENTS = 60_000;
/** Index writes are coalesced; lifecycle boundaries flush immediately. */
const INDEX_WRITE_DEBOUNCE_MS = 250;

/** One bounded timeline page, in `seq` order. */
export interface LedgerPage {
  events: LedgerEvent[];
  /** The `seq` of the timeline's newest event, regardless of the page. */
  lastSeq: number;
  /** True when the timeline has more events after this page. */
  hasMore: boolean;
}

/** One resident timeline: its frozen events plus their serialized byte size. */
interface LoadedSession {
  events: LedgerEvent[];
  bytes: number;
}

export interface LedgerOptions {
  stateRoot: string;
  workspaceRoot: string;
  now?: () => Date;
}

interface LedgerIndexFile {
  sessions: SessionSummary[];
}

export class Ledger {
  private readonly now: () => Date;
  private readonly sessionsDir: string;
  private readonly indexPath: string;
  private readonly documents: DocumentCommitter;
  private readonly summaries = new Map<string, SessionSummary>();
  /** Loaded timelines in access order: the oldest entry is evicted first. */
  private readonly events = new Map<string, LoadedSession>();
  /** Sessions whose persisted summary is incomplete or behind their timeline. */
  private readonly staleSummaries = new Set<string>();
  /**
   * Sessions whose resident timeline must not be evicted: an append is writing
   * its file and the entry is the only array that already holds the event.
   */
  private readonly pinned = new Set<string>();
  private readonly listeners = new Map<string, Set<(event: LedgerEvent) => void>>();
  /** Serialized append chain; every mutation waits for the previous one. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Serialized index-write chain, so two flushes never interleave. */
  private writeChain: Promise<unknown> = Promise.resolve();
  private indexTimer?: ReturnType<typeof setTimeout>;
  private cachedBytes = 0;
  private cachedEvents = 0;

  constructor(options: LedgerOptions) {
    this.now = options.now ?? (() => new Date());
    const digest = createHash('sha256').update(options.workspaceRoot, 'utf8').digest('hex');
    const rootDir = join(options.stateRoot, 'session', digest);
    this.sessionsDir = join(rootDir, 'sessions');
    this.indexPath = join(rootDir, 'index.json');
    // Loading is synchronous, so `listSessions` and `read` work immediately
    // after construction; `init` recovers any pending document commit before use.
    // Constructor work is metadata-only: the index plus one stat per timeline
    // file, never a JSONL body.
    mkdirSync(this.sessionsDir, { recursive: true });
    this.loadIndexSync();
    this.reconcileIndexSync();
    this.documents = new DocumentCommitter(options.workspaceRoot, rootDir,
      sessionId => this.read(sessionId), (sessionId, draft) => this.appendNow(sessionId, draft, true),
      async sessionId => {
        const handle = await open(this.sessionFile(sessionId), 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
      });
  }

  init(): Promise<void> {
    return this.enqueue(() => this.documents.recover());
  }

  /** Durable append: the event is on disk (`fsync`ed) before this resolves. */
  append(sessionId: string, draft: LedgerEventDraft): Promise<LedgerEvent> {
    return this.enqueue(async () => {
      await this.documents.recover();
      return this.appendNow(sessionId, draft);
    });
  }

  /** The sole file-and-ledger document mutation entry point. */
  commitDocument(input: DocumentCommit): Promise<void> {
    const captured = structuredClone(input);
    return this.enqueue(() => this.documents.commit(captured));
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    // Keep the chain alive after a failed append so later appends still run.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** A snapshot copy of one timeline; the events themselves are frozen. */
  read(sessionId: string): LedgerEvent[] {
    assertSessionId(sessionId);
    return [...this.loadSessionSync(sessionId)];
  }

  /**
   * One bounded page of a timeline: the events whose `seq` is greater than
   * `afterSeq`, at most `limit` of them. Only the page is copied; the cached
   * timeline itself is sliced, not filtered or duplicated, and `lastSeq` comes
   * from the original tail.
   *
   * When the body is not resident and the index still describes the file, a
   * page whose `afterSeq` is already at or past the indexed tail returns empty
   * without parsing the JSONL. An unknown session is rejected here so callers
   * do not have to read the whole timeline to find out it is missing.
   */
  readPage(sessionId: string, afterSeq: number, limit: number): LedgerPage {
    assertSessionId(sessionId);
    const cached = this.events.get(sessionId);
    if (cached !== undefined) {
      this.touch(sessionId, cached);
      return pageOf(cached.events, afterSeq, limit);
    }
    // A session that is neither resident nor on disk cannot serve a page.
    if (!existsSync(this.sessionFile(sessionId))) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const summary = this.summaries.get(sessionId);
    if (summary !== undefined
      && !this.staleSummaries.has(sessionId)
      && summary.lastSeq !== undefined
      && afterSeq >= summary.lastSeq) {
      return { events: [], lastSeq: summary.lastSeq, hasMore: false };
    }
    const events = this.loadSessionSync(sessionId);
    if (events.length === 0) throw new Error(`Unknown session: ${sessionId}`);
    return pageOf(events, afterSeq, limit);
  }

  listSessions(): SessionSummary[] {
    return [...this.summaries.values()]
      .map((summary) => ({ ...summary }))
      .sort((a, b) => {
        if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
        return a.sessionId.localeCompare(b.sessionId);
      });
  }

  subscribe(sessionId: string, listener: (event: LedgerEvent) => void): () => void {
    assertSessionId(sessionId);
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    const current = set;
    return () => {
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(sessionId);
    };
  }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
    // A debounced index write must not be lost on a clean shutdown.
    this.cancelIndexTimer();
    await this.flushIndex().catch(() => undefined);
    this.listeners.clear();
    this.dropAllSessions();
  }

  /**
   * Serialized session deletion: removes the timeline file and the derived
   * index entry. Only a known session may be deleted and an invalid id is
   * rejected before any filesystem work.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const run = this.queue.then(async () => { await this.documents.recover(); await this.deleteSessionNow(sessionId); });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async deleteSessionNow(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    const file = this.sessionFile(sessionId);
    const known = this.summaries.has(sessionId) || this.events.has(sessionId) || existsSync(file);
    if (!known) throw new Error(`unknown session: ${sessionId}`);
    this.dropSession(sessionId);
    this.summaries.delete(sessionId);
    this.staleSummaries.delete(sessionId);
    const listeners = this.listeners.get(sessionId);
    if (listeners) {
      listeners.clear();
      this.listeners.delete(sessionId);
    }
    await rm(file, { force: true });
    // Deletion is a lifecycle boundary: the index must not resurrect the entry.
    await this.flushIndex();
  }

  // ── append internals ───────────────────────────────────────────────────

  private async appendNow(sessionId: string, draft: LedgerEventDraft, documentCommit = false): Promise<LedgerEvent> {
    assertSessionId(sessionId);
    // The file write below awaits, so the event loop can serve readers in
    // between and evict this timeline: a reload would parse the file while the
    // line is being appended and truncate it, and it would hand out an array
    // without the event this append already wrote. Pin the entry for the whole
    // write — an oversized one included, which the caps would otherwise drop as
    // soon as it is loaded — so every concurrent read reuses the same array.
    this.pinned.add(sessionId);
    try {
      const events = this.loadSessionSync(sessionId);
      if (draft.type === 'workspace.changed' && draft.scope === 'document' && !documentCommit) {
        throw new Error('Document changes must use commitDocument');
      }
      if (draft.type === 'document.content') {
        const { path, version } = draft;
        if (!documentCommit) this.documents.validateSnapshot(path, version);
        if (draft.source === 'write' && !documentCommit) throw new Error('Document writes must use commitDocument');
        if (draft.format !== 'full' || draft.base !== undefined || contentVersion(draft.content) !== version) {
          throw new Error('Document append requires a verified full snapshot');
        }
        const change = documentChange(path, currentDocument(events, path)?.content, draft.content);
        if (change === undefined) return events.findLast(event => event.type === 'document.content'
          && event.path === path && event.version === version)!;
        draft = { ...draft, ...change };
        currentDocument([...events, { ...draft, seq: 0, at: '' }], draft.path);
      }
      const previousSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
      // Clone before freezing so caller-owned nested objects stay untouched.
      const event = deepFreeze(
        structuredClone({ ...draft, seq: previousSeq + 1, at: this.now().toISOString() }),
      ) as LedgerEvent;

      const line = `${JSON.stringify(event)}\n`;
      const lineBytes = Buffer.byteLength(line, 'utf8');
      await appendLine(this.sessionFile(sessionId), line);
      events.push(event);
      const previousBytes = this.summaries.get(sessionId)?.bytes ?? 0;
      const entry = this.events.get(sessionId);
      if (entry !== undefined && entry.events === events) {
        entry.bytes += lineBytes;
        this.cachedBytes += lineBytes;
        this.cachedEvents += 1;
      }
      this.applySummary(sessionId, event, events, previousBytes + lineBytes);
      // A turn boundary decides whether the session is recoverable after a crash,
      // so it is persisted before the append resolves instead of waiting for the
      // debounce. Every other event only refreshes derived metadata.
      if (isLifecycleEvent(event)) await this.flushIndex();
      else this.scheduleIndexWrite();
      this.emit(sessionId, event);
      return event;
    } catch (error) {
      this.dropSession(sessionId);
      this.staleSummaries.add(sessionId);
      throw error;
    } finally {
      // Release the pin however the append ended, a failed write included, then
      // re-apply the caps so a timeline only the pin kept resident (an
      // oversized one) is not retained once the append has settled.
      this.pinned.delete(sessionId);
      this.evictSessions();
    }
  }

  private applySummary(
    sessionId: string,
    event: LedgerEvent,
    events: readonly LedgerEvent[],
    bytes: number,
  ): void {
    const previous = this.summaries.get(sessionId);
    const createdAt = previous?.createdAt ?? event.at;
    let title = previous?.title ?? DEFAULT_TITLE;
    let manualTitle = previous?.manualTitle === true;
    const titled = titleOfEvent(event);
    // A generated title may not overwrite a manual one; a later manual title
    // always wins.
    if (titled !== undefined && (!manualTitle || titled.manual)) {
      title = titled.title;
      manualTitle = titled.manual;
    }
    // Only the fields a `session.metadata` event carries change; the other flag
    // keeps its prior value and title/manualTitle are never touched.
    let archived = previous?.archived === true;
    let pinned = previous?.pinned === true;
    if (event.type === 'session.metadata') {
      if (event.archived !== undefined) archived = event.archived;
      if (event.pinned !== undefined) pinned = event.pinned;
    }
    const lastTurn = lastTurnAfter(previous?.lastTurn, event, events, events.length);
    this.summaries.set(sessionId, {
      sessionId,
      title,
      ...(manualTitle ? { manualTitle } : {}),
      ...(archived ? { archived } : {}),
      ...(pinned ? { pinned } : {}),
      createdAt,
      updatedAt: event.at,
      ...(lastTurn === undefined ? {} : { lastTurn }),
      lastSeq: event.seq,
      pendingTurns: pendingTurnsAfter(previous?.pendingTurns, event),
      bytes,
    });
    this.staleSummaries.delete(sessionId);
  }

  private emit(sessionId: string, event: LedgerEvent): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // A listener must never break the append queue.
      }
    }
  }

  // ── load / index internals ─────────────────────────────────────────────

  private sessionFile(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  private loadSessionSync(sessionId: string): LedgerEvent[] {
    const cached = this.events.get(sessionId);
    if (cached !== undefined) {
      this.touch(sessionId, cached);
      return cached.events;
    }
    let events: LedgerEvent[] = [];
    let bytes = 0;
    const file = this.sessionFile(sessionId);
    if (existsSync(file)) {
      const buffer = readFileSync(file);
      bytes = buffer.length;
      const parsed = parseSessionFile(buffer, file);
      if (parsed.tornFrom !== undefined) {
        truncateSync(file, parsed.tornFrom);
        bytes = parsed.tornFrom;
      }
      events = parsed.events.map((event) => deepFreeze(event));
    }
    this.rebuildSummaryIfNeeded(sessionId, events, bytes);
    this.storeSession(sessionId, events, bytes);
    return events;
  }

  /**
   * Replace a placeholder or stale summary with one derived from the body that
   * was just parsed. A summary the index still describes is left alone.
   */
  private rebuildSummaryIfNeeded(sessionId: string, events: readonly LedgerEvent[], bytes: number): void {
    const existing = this.summaries.get(sessionId);
    if (existing !== undefined && !this.staleSummaries.has(sessionId)) {
      if (existing.bytes !== bytes) {
        existing.bytes = bytes;
        this.scheduleIndexWrite();
      }
      return;
    }
    if (events.length === 0) {
      // An empty timeline carries no summary; a placeholder stays a placeholder.
      if (existing !== undefined) existing.bytes = bytes;
      return;
    }
    const summary = summarize(sessionId, events);
    this.summaries.set(sessionId, {
      ...summary,
      lastSeq: events[events.length - 1]!.seq,
      pendingTurns: pendingTurnsOf(events),
      bytes,
    });
    this.staleSummaries.delete(sessionId);
    this.scheduleIndexWrite();
  }

  private loadIndexSync(): void {
    this.summaries.clear();
    this.staleSummaries.clear();
    if (!existsSync(this.indexPath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.indexPath, 'utf8'));
      const sessions = (parsed as { sessions?: unknown } | null)?.sessions;
      if (!Array.isArray(sessions)) return;
      for (const item of sessions) {
        const summary = readSummary(item);
        if (summary) {
          this.summaries.set(summary.sessionId, summary);
          // A complete summary is trusted only once the directory scan confirms
          // its recorded size; until then it must never drive the tail fast path.
          this.staleSummaries.add(summary.sessionId);
        }
      }
    } catch {
      // index.json is derived state; a damaged copy is rebuilt from the JSONL
      // timelines on first touch instead of being trusted.
      this.summaries.clear();
      this.staleSummaries.clear();
    }
  }

  /**
   * Reconcile the index with the session directory using filenames and file
   * metadata only. Summaries whose file is gone are dropped; unindexed files
   * become placeholders; a summary whose recorded size no longer matches its
   * file is marked stale so the first body load rebuilds it. No JSONL body is
   * read here.
   */
  private reconcileIndexSync(): void {
    const files = existsSync(this.sessionsDir) ? readdirSync(this.sessionsDir) : [];
    const onDisk = new Map<string, { size: number; createdAt: string; updatedAt: string }>();
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.slice(0, -'.jsonl'.length);
      assertSessionId(sessionId);
      try {
        const stat = statSync(join(this.sessionsDir, file));
        if (!stat.isFile()) continue;
        onDisk.set(sessionId, {
          size: stat.size,
          createdAt: (stat.birthtimeMs > 0 && stat.birthtimeMs <= stat.mtimeMs
            ? stat.birthtime
            : stat.mtime).toISOString(),
          updatedAt: stat.mtime.toISOString(),
        });
      } catch {
        // An unreadable timeline is retried on first touch, not at startup.
      }
    }
    const previous = JSON.stringify(this.indexFile());
    for (const sessionId of [...this.summaries.keys()]) {
      if (!onDisk.has(sessionId)) {
        this.summaries.delete(sessionId);
        this.staleSummaries.delete(sessionId);
      }
    }
    for (const [sessionId, stat] of onDisk) {
      const summary = this.summaries.get(sessionId);
      if (summary === undefined) {
        // An unindexed timeline is registered from its file metadata; the body
        // is read only when something first asks for it.
        this.summaries.set(sessionId, {
          sessionId,
          title: DEFAULT_TITLE,
          createdAt: stat.createdAt,
          updatedAt: stat.updatedAt,
          bytes: stat.size,
        });
        this.staleSummaries.add(sessionId);
        continue;
      }
      const complete = summary.lastSeq !== undefined
        && summary.pendingTurns !== undefined;
      if (complete && summary.bytes === stat.size) {
        this.staleSummaries.delete(sessionId);
        continue;
      }
      // The timeline outgrew the index (a crash between append and a debounced
      // write) or predates these fields. Marking the summary stale keeps the
      // uncertainty for deferred recovery: an unindexed file or a legacy entry
      // without pending-turn metadata is rebuilt from its body on first touch,
      // still without any body read at startup.
      //
      // Both the tail position and the pending-turn list are invalidated, not
      // just lastSeq. A persisted pendingTurns is NOT a safe superset of the
      // truth: a crash can land after a turn.started line is fsynced into the
      // JSONL but before the atomic index rename, so the on-disk list is
      // typically empty and misses that unfinished turn. Keeping it would let
      // a byte-mismatched summary masquerade as a trusted recovery signal.
      // A missing pendingTurns routes the session to uncertain recovery, which
      // the engine defers to the post-listen body replay pass.
      delete summary.lastSeq;
      delete summary.pendingTurns;
      summary.bytes = stat.size;
      this.staleSummaries.add(sessionId);
    }
    if (previous !== JSON.stringify(this.indexFile())) this.writeIndexSync();
  }

  // ── cache internals ────────────────────────────────────────────────────

  private storeSession(sessionId: string, events: LedgerEvent[], bytes: number): void {
    this.dropSession(sessionId);
    this.events.set(sessionId, { events, bytes });
    this.cachedBytes += bytes;
    this.cachedEvents += events.length;
    this.evictSessions();
  }

  /** Mark one resident timeline as most recently used. */
  private touch(sessionId: string, entry: LoadedSession): void {
    this.events.delete(sessionId);
    this.events.set(sessionId, entry);
  }

  private dropSession(sessionId: string): void {
    const entry = this.events.get(sessionId);
    if (entry === undefined) return;
    this.events.delete(sessionId);
    this.cachedBytes -= entry.bytes;
    this.cachedEvents -= entry.events.length;
  }

  private dropAllSessions(): void {
    this.events.clear();
    this.cachedBytes = 0;
    this.cachedEvents = 0;
  }

  /**
   * Evict from the least recently used end until every cap holds. An
   * individually oversized session is evicted by this same loop, so it is never
   * retained even when it is the only entry. A pinned session is skipped: the
   * append that pinned it releases the pin and re-runs this loop once its write
   * has settled.
   */
  private evictSessions(): void {
    while (
      this.events.size > MAX_CACHED_SESSIONS
      || this.cachedBytes > MAX_CACHED_BYTES
      || this.cachedEvents > MAX_CACHED_EVENTS
    ) {
      let oldest: string | undefined;
      for (const sessionId of this.events.keys()) {
        if (this.pinned.has(sessionId)) continue;
        oldest = sessionId;
        break;
      }
      if (oldest === undefined) return;
      this.dropSession(oldest);
    }
  }

  // ── index persistence ──────────────────────────────────────────────────

  private scheduleIndexWrite(): void {
    if (this.indexTimer !== undefined) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = undefined;
      void this.flushIndex().catch(() => undefined);
    }, INDEX_WRITE_DEBOUNCE_MS);
    this.indexTimer.unref();
  }

  private cancelIndexTimer(): void {
    if (this.indexTimer === undefined) return;
    clearTimeout(this.indexTimer);
    this.indexTimer = undefined;
  }

  /** Serialize one index write behind every earlier one. */
  private flushIndex(): Promise<void> {
    this.cancelIndexTimer();
    const run = this.writeChain.then(() => this.writeIndexAtomic());
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private writeIndexSync(): void {
    const data = `${JSON.stringify(this.indexFile(), null, 2)}\n`;
    const temp = `${this.indexPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    writeFileSync(temp, data, 'utf8');
    renameSync(temp, this.indexPath);
  }

  private async writeIndexAtomic(): Promise<void> {
    const data = `${JSON.stringify(this.indexFile(), null, 2)}\n`;
    const temp = `${this.indexPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const handle = await open(temp, 'w');
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, this.indexPath);
  }

  private indexFile(): LedgerIndexFile {
    return { sessions: [...this.summaries.values()].map((summary) => ({ ...summary })) };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** The display title a `session.titled` event carries, when it is non-empty. */
function titleOfEvent(event: LedgerEvent): { title: string; manual: boolean } | undefined {
  if (event.type !== 'session.titled') return undefined;
  const title = event.text.trim();
  return title === '' ? undefined : { title, manual: event.manual === true };
}

/** Failure facts of a failed model span in a turn, for `SessionSummary.lastTurn`. */
interface FailedSpanFacts {
  errorKind: string;
  errorMessage: string;
  retryAt?: string;
}

/**
 * The newest turn number that has started within the applied prefix, if any.
 * Turn numbers increase with start order, but taking the maximum is immune to
 * any out-of-order arrival, so an older started turn can never look newest.
 */
function newestStartedTurn(events: readonly LedgerEvent[], bound: number): number | undefined {
  let newest: number | undefined;
  for (let index = 0; index < bound; index += 1) {
    const event = events[index]!;
    if (event.type !== 'turn.started') continue;
    if (event.turn === undefined) continue;
    if (newest === undefined || event.turn > newest) newest = event.turn;
  }
  return newest;
}

/**
 * The last failed model span of a turn among the applied prefix, if any: its
 * structured error kind and message, plus the latest retry-after hint on its
 * attempts. It scans only `events[0..bound)` — the prefix up to and including
 * the `turn.finished` being applied — so a `span.finished` appended after that
 * turn cannot change the turn's error facts when the index is recomputed from
 * the timeline on the next load. No new ledger read is added.
 */
function failedSpanFacts(events: readonly LedgerEvent[], bound: number, turn: number): FailedSpanFacts | undefined {
  let found: FailedSpanFacts | undefined;
  for (let index = 0; index < bound; index += 1) {
    const event = events[index]!;
    if (event.type !== 'span.finished') continue;
    if (event.turn !== turn) continue;
    if (event.kind === 'task') continue;
    if (event.status !== 'failed' || event.error === undefined) continue;
    const facts: FailedSpanFacts = {
      errorKind: event.error.kind,
      errorMessage: event.error.message,
    };
    // A transport attempt carries the route's own retry instant (`routeUntil`)
    // as a typed field; the newest one that produced it becomes the span's
    // `retryAt`, which flows into `SessionSummary.lastTurn.retryAt`. A failure
    // that never issued a request — every candidate route was cooling down or
    // probing — carries its retry instant on the error itself instead.
    for (const attempt of event.metrics?.attempts ?? []) {
      const routeUntil = attempt.routeUntil;
      if (typeof routeUntil === 'string' && routeUntil !== '') facts.retryAt = routeUntil;
    }
    const failureRetryAt = event.error.retryAt;
    if (typeof failureRetryAt === 'string' && failureRetryAt !== '') facts.retryAt = failureRetryAt;
    found = facts;
  }
  return found;
}

/**
 * Advance the derived last-turn fact for one event, exactly like the `title`
 * derivation: `turn.started` clears it, `turn.finished` records the outcome
 * (with a failed span's error and retry hint when present), and
 * `turn.attention` adds the user-attention flag and label. Every other event
 * leaves it unchanged.
 *
 * `bound` is the length of the applied prefix including `event` itself. Both
 * the failed-span scan and the newest-turn check stay inside it, so the append
 * path and the recompute path derive an identical `lastTurn`.
 */
function lastTurnAfter(
  previous: SessionSummary['lastTurn'],
  event: LedgerEvent,
  events: readonly LedgerEvent[],
  bound: number,
): SessionSummary['lastTurn'] {
  switch (event.type) {
    case 'turn.started':
      return undefined;
    case 'turn.finished': {
      // Only the newest started turn owns `lastTurn`. An older turn finishing
      // later must not overwrite the newer outcome, and a turn that started but
      // has not finished leaves `lastTurn` cleared.
      const turn = event.turn;
      if (turn === undefined) return previous;
      const newest = newestStartedTurn(events, bound);
      if (newest !== undefined && turn !== newest) return previous;
      const failed = event.status === 'failed' ? failedSpanFacts(events, bound, turn) : undefined;
      return {
        status: event.status,
        finishedAt: event.at,
        turn,
        ...(failed === undefined ? {} : {
          errorKind: failed.errorKind,
          errorMessage: failed.errorMessage,
          ...(failed.retryAt === undefined ? {} : { retryAt: failed.retryAt }),
        }),
        // A failed turn with no failed span keeps its own error text.
        ...(event.status === 'failed' && failed === undefined && event.error !== undefined
          ? { errorMessage: event.error }
          : {}),
      };
    }
    case 'turn.attention':
      // Nothing to annotate when no finished turn was recorded, and only the
      // turn that owns `lastTurn` may set needsUser/label. A marker from any
      // other turn leaves it unchanged.
      if (previous === undefined || previous.turn !== event.turn) return previous;
      return {
        ...previous,
        needsUser: event.needsUser,
        ...(event.label === undefined ? {} : { label: event.label }),
      };
    default:
      return previous;
  }
}

/**
 * Every distinct session file a timeline records through `files.attached`
 * events, keyed by path + hash, with the latest record kept and first-seen
 * timeline order.
 */
export function collectSessionFiles(events: readonly LedgerEvent[]): SessionFile[] {
  const files = new Map<string, SessionFile>();
  for (const event of events) {
    if (event.type !== 'files.attached') continue;
    for (const file of event.files) files.set(`${file.path}\u0000${file.hash}`, { ...file });
  }
  return [...files.values()];
}

/**
 * Every image occurrence in the context, in event order. An image stays in the
 * context for the life of the session, exactly like a loaded document.
 * Occurrences are identified by the actual `SessionFile` objects (no path/hash
 * dedup), and an occurrence is counted even when its preview is missing.
 */
export function contextImageFiles(events: readonly LedgerEvent[]): ReadonlySet<SessionFile> {
  const selected = new Set<SessionFile>();
  for (const event of events) {
    if (event.type !== 'files.attached') continue;
    for (const file of event.files) {
      if (file.kind === 'image') selected.add(file);
    }
  }
  return selected;
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
}

function summarize(sessionId: string, events: readonly LedgerEvent[]): SessionSummary {
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let title = DEFAULT_TITLE;
  let manualTitle = false;
  let archived = false;
  let pinned = false;
  let lastTurn: SessionSummary['lastTurn'];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.type === 'session.created') createdAt = event.at;
    const titled = titleOfEvent(event);
    if (titled !== undefined && (!manualTitle || titled.manual)) {
      title = titled.title;
      manualTitle = titled.manual;
    }
    // The latest metadata event wins; a field it omits keeps the prior value.
    if (event.type === 'session.metadata') {
      if (event.archived !== undefined) archived = event.archived;
      if (event.pinned !== undefined) pinned = event.pinned;
    }
    // The recompute path passes the prefix ending at this event, exactly like
    // the append path, so a later append cannot change an earlier turn.
    lastTurn = lastTurnAfter(lastTurn, event, events, index + 1);
    updatedAt = event.at;
  }
  const created = createdAt ?? updatedAt ?? '';
  return {
    sessionId,
    title,
    ...(manualTitle ? { manualTitle } : {}),
    ...(archived ? { archived } : {}),
    ...(pinned ? { pinned } : {}),
    createdAt: created,
    updatedAt: updatedAt ?? created,
    ...(lastTurn === undefined ? {} : { lastTurn }),
  };
}

function readSummary(value: unknown): SessionSummary | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const { sessionId, title, createdAt, updatedAt } = record;
  if (
    typeof sessionId !== 'string'
    || typeof title !== 'string'
    || typeof createdAt !== 'string'
    || typeof updatedAt !== 'string'
  ) {
    return undefined;
  }
  const lastTurn = readLastTurn(record.lastTurn);
  const lastSeq = nonNegativeInteger(record.lastSeq);
  const bytes = nonNegativeInteger(record.bytes);
  const pendingTurns = readPendingTurns(record.pendingTurns);
  return {
    sessionId,
    title,
    ...(record.manualTitle === true ? { manualTitle: true } : {}),
    ...(record.archived === true ? { archived: true } : {}),
    ...(record.pinned === true ? { pinned: true } : {}),
    createdAt,
    updatedAt,
    ...(lastTurn === undefined ? {} : { lastTurn }),
    ...(lastSeq === undefined ? {} : { lastSeq }),
    ...(pendingTurns === undefined ? {} : { pendingTurns }),
    ...(bytes === undefined ? {} : { bytes }),
  };
}

/** Validate one persisted `lastTurn`; an invalid fact is dropped as a whole. */
function readLastTurn(value: unknown): SessionSummary['lastTurn'] | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== 'completed' && status !== 'failed' && status !== 'interrupted') return undefined;
  const finishedAt = record.finishedAt;
  const turn = record.turn;
  if (typeof finishedAt !== 'string' || typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1) return undefined;
  return {
    status,
    finishedAt,
    turn,
    ...(record.needsUser === true ? { needsUser: true } : {}),
    ...(typeof record.label === 'string' ? { label: record.label } : {}),
    ...(typeof record.errorKind === 'string' ? { errorKind: record.errorKind } : {}),
    ...(typeof record.errorMessage === 'string' ? { errorMessage: record.errorMessage } : {}),
    ...(typeof record.retryAt === 'string' ? { retryAt: record.retryAt } : {}),
  };
}

/** Validate one persisted pending-turn list; any invalid entry distrusts it. */
function readPendingTurns(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const turns: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1) return undefined;
    turns.push(entry);
  }
  return turns.sort((left, right) => left - right);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The turns that started without a matching `turn.finished`, ascending. */
function pendingTurnsOf(events: readonly LedgerEvent[]): number[] {
  const started = new Set<number>();
  const finished = new Set<number>();
  for (const event of events) {
    if (typeof event.turn !== 'number') continue;
    if (event.type === 'turn.started') started.add(event.turn);
    else if (event.type === 'turn.finished') finished.add(event.turn);
  }
  return [...started].filter((turn) => !finished.has(turn)).sort((left, right) => left - right);
}

/** Advance the pending-turn list with one appended event. */
function pendingTurnsAfter(previous: readonly number[] | undefined, event: LedgerEvent): number[] {
  const turns = new Set(previous ?? []);
  if (typeof event.turn === 'number') {
    if (event.type === 'turn.started') turns.add(event.turn);
    else if (event.type === 'turn.finished') turns.delete(event.turn);
  }
  return [...turns].sort((left, right) => left - right);
}

/**
 * Whether one event changes the state startup recovery depends on. Only these
 * flush the index before the append resolves; everything else is coalesced.
 */
function isLifecycleEvent(event: LedgerEvent): boolean {
  return event.type === 'session.created'
    || event.type === 'turn.started'
    || event.type === 'turn.interrupted'
    || event.type === 'turn.finished';
}

/** Slice the bounded page after `afterSeq` out of one timeline. */
function pageOf(events: readonly LedgerEvent[], afterSeq: number, limit: number): LedgerPage {
  const start = firstSeqAfter(events, afterSeq);
  const width = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : events.length;
  const end = Math.min(events.length, start + width);
  return {
    events: events.slice(start, end),
    lastSeq: events.length > 0 ? events[events.length - 1]!.seq : 0,
    hasMore: end < events.length,
  };
}

/** Binary search the first event whose `seq` is greater than `afterSeq`. */
function firstSeqAfter(events: readonly LedgerEvent[], afterSeq: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle]!.seq <= afterSeq) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Parse a JSONL buffer, dropping only a torn (newline-less) final fragment. */
function parseSessionFile(buffer: Buffer, file: string): { events: LedgerEvent[]; tornFrom?: number } {
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
  // Bytes after the last newline are a torn write; truncate them before any
  // further append. A complete line that fails to parse is corruption instead.
  return { events, ...(start < buffer.length ? { tornFrom: start } : {}) };
}

function parseEventLine(line: string, file: string, offset: number): LedgerEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`session ledger is corrupt at ${file} byte ${offset}; refusing to discard it`);
  }
  if (
    value === null
    || typeof value !== 'object'
    || typeof (value as Record<string, unknown>).seq !== 'number'
    || typeof (value as Record<string, unknown>).at !== 'string'
    || typeof (value as Record<string, unknown>).type !== 'string'
  ) {
    throw new Error(`session ledger has an invalid event at ${file} byte ${offset}`);
  }
  return value as LedgerEvent;
}

async function appendLine(file: string, line: string): Promise<void> {
  const handle = await open(file, 'a');
  try {
    await handle.writeFile(line, 'utf8');
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
