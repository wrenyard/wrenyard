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
 * The JSONL reader tolerates exactly one thing: a torn final line (a trailing
 * fragment with no closing newline). It truncates that fragment before any
 * further append. Any other malformed line is corruption and throws instead of
 * being silently discarded.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionFile } from '@wrenyard/protocol';
import type { LedgerEvent, LedgerEventDraft } from './events.ts';
import { normalizeStoredEvent } from './compat.ts';

// ─── Event model ───────────────────────────────────────────────────────────

/**
 * The append-only event model lives in `./ledger/events.ts`; the ledger
 * re-exports it so every `./ledger.ts` consumer keeps importing the same names.
 */
export * from './events.ts';

// ─── Ledger ────────────────────────────────────────────────────────────────

/** One row of `index.json`. */
export interface SessionSummary {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Runtime-derived: whether the session has an in-flight turn right now. Never
   * persisted to `index.json`; only the session engine populates it in memory.
   */
  running?: boolean;
}

const DEFAULT_TITLE = '新会话';
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

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
  private readonly summaries = new Map<string, SessionSummary>();
  private readonly events = new Map<string, LedgerEvent[]>();
  private readonly listeners = new Map<string, Set<(event: LedgerEvent) => void>>();
  /** Serialized append chain; every mutation waits for the previous one. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: LedgerOptions) {
    this.now = options.now ?? (() => new Date());
    const digest = createHash('sha256').update(options.workspaceRoot, 'utf8').digest('hex');
    const rootDir = join(options.stateRoot, 'session', digest);
    this.sessionsDir = join(rootDir, 'sessions');
    this.indexPath = join(rootDir, 'index.json');
    // Loading is synchronous, so `listSessions` and `read` work immediately
    // after construction; `init` only exists to satisfy the async port.
    mkdirSync(this.sessionsDir, { recursive: true });
    this.loadIndexSync();
    this.reconcileIndexSync();
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  /** Durable append: the event is on disk (`fsync`ed) before this resolves. */
  append(sessionId: string, draft: LedgerEventDraft): Promise<LedgerEvent> {
    const run = this.queue.then(() => this.appendNow(sessionId, draft));
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
    this.listeners.clear();
  }

  /**
   * Serialized session deletion: removes the timeline file and the derived
   * index entry. Only a known session may be deleted and an invalid id is
   * rejected before any filesystem work.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const run = this.queue.then(() => this.deleteSessionNow(sessionId));
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
    this.events.delete(sessionId);
    this.summaries.delete(sessionId);
    const listeners = this.listeners.get(sessionId);
    if (listeners) {
      listeners.clear();
      this.listeners.delete(sessionId);
    }
    await rm(file, { force: true });
    this.writeIndexSync();
  }

  // ── append internals ───────────────────────────────────────────────────

  private async appendNow(sessionId: string, draft: LedgerEventDraft): Promise<LedgerEvent> {
    assertSessionId(sessionId);
    const events = this.loadSessionSync(sessionId);
    const previousSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
    // Clone before freezing so caller-owned nested objects stay untouched.
    const event = deepFreeze(
      structuredClone({ ...draft, seq: previousSeq + 1, at: this.now().toISOString() }),
    ) as LedgerEvent;

    await appendLine(this.sessionFile(sessionId), `${JSON.stringify(event)}\n`);
    events.push(event);
    this.applySummary(sessionId, event);
    await this.writeIndexAtomic();
    this.emit(sessionId, event);
    return event;
  }

  private applySummary(sessionId: string, event: LedgerEvent): void {
    const previous = this.summaries.get(sessionId);
    const createdAt = previous?.createdAt ?? event.at;
    let title = previous?.title ?? DEFAULT_TITLE;
    const titled = titleOfEvent(event);
    if (titled !== undefined) title = titled;
    this.summaries.set(sessionId, { sessionId, title, createdAt, updatedAt: event.at });
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
    if (cached) return cached;
    let events: LedgerEvent[] = [];
    const file = this.sessionFile(sessionId);
    if (existsSync(file)) {
      const parsed = parseSessionFile(readFileSync(file), file);
      if (parsed.tornFrom !== undefined) truncateSync(file, parsed.tornFrom);
      events = parsed.events.map((event) => deepFreeze(event));
    }
    this.events.set(sessionId, events);
    return events;
  }

  private loadIndexSync(): void {
    this.summaries.clear();
    if (!existsSync(this.indexPath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.indexPath, 'utf8'));
      const sessions = (parsed as { sessions?: unknown } | null)?.sessions;
      if (!Array.isArray(sessions)) return;
      for (const item of sessions) {
        const summary = readSummary(item);
        if (summary) this.summaries.set(summary.sessionId, summary);
      }
    } catch {
      // index.json is derived state; a damaged copy is rebuilt from the JSONL
      // timelines below instead of being trusted.
      this.summaries.clear();
    }
  }

  /** Ensure every timeline on disk has an index entry, deriving the missing ones. */
  private reconcileIndexSync(): void {
    const files = existsSync(this.sessionsDir) ? readdirSync(this.sessionsDir) : [];
    const previous = JSON.stringify(this.indexFile());
    this.summaries.clear();
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.slice(0, -'.jsonl'.length);
      assertSessionId(sessionId);
      const events = this.loadSessionSync(sessionId);
      if (events.length > 0) this.summaries.set(sessionId, summarize(sessionId, events));
    }
    if (previous !== JSON.stringify(this.indexFile())) this.writeIndexSync();
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
function titleOfEvent(event: LedgerEvent): string | undefined {
  if (event.type !== 'session.titled') return undefined;
  const title = event.text.trim();
  return title === '' ? undefined : title;
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
  for (const event of events) {
    if (event.type === 'session.created') createdAt = event.at;
    const titled = titleOfEvent(event);
    if (titled !== undefined) title = titled;
    updatedAt = event.at;
  }
  const created = createdAt ?? updatedAt ?? '';
  return { sessionId, title, createdAt: created, updatedAt: updatedAt ?? created };
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
  return { sessionId, title, createdAt, updatedAt };
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
