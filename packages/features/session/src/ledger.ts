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
import type { ReasoningEffort } from '@wrenyard/models';
import type { CallRole } from './calls.ts';
import type { ActionKind } from './actions/index.ts';
import { normalizeStoredEvent } from './event-compat.ts';

// ─── Event model ───────────────────────────────────────────────────────────

/** The `type` discriminant of every ledger event. */
export type LedgerEventType =
  | 'session.created'
  | 'turn.started'
  | 'cycle.started'
  | 'thinking'
  | 'doc.search'
  | 'doc.content'
  | 'files'
  | 'memory.recalled'
  | 'reason.completed'
  | 'action.started'
  | 'action.titled'
  | 'action.finished'
  | 'reply'
  | 'ws.updated'
  | 'turn.interrupted'
  | 'turn.finished'
  | 'title'
  | 'call.started'
  | 'call'
  | 'error';

/** The terminal states of a work turn. */
export type TurnStatus = 'completed' | 'failed' | 'interrupted';

/** Mirrors the committed action statuses owned by `actions.ts`. */
export type ActionStatus = 'done' | 'failed' | 'skipped' | 'cancelled';

/** Provider usage as reported by the driver; absent fields stay absent. */
export interface Usage {
  input?: number;
  cachedInput?: number;
  output?: number;
  reasoning?: number;
}

/** The expensive model a turn was started with. */
export interface TurnModel {
  provider: string;
  model: string;
  /** Explicit public reasoning level this turn runs at. */
  reasoningEffort?: ReasoningEffort;
}

/** Fields common to every ledger event; `seq` and `at` are assigned on append. */
export interface LedgerEventBase {
  /** Global, strictly increasing sequence number within the session. */
  seq: number;
  /** ISO 8601 timestamp with timezone designator. */
  at: string;
  type: LedgerEventType;
  turn?: number;
  cycle?: number;
}

export interface TaskBrief {
  id: string;
  description: string;
  inputSummary: string[];
}

export interface ProjectSnapshot {
  /** Registered project id. */
  id: string;
  displayName?: string;
  /** Workspace-relative project directory, e.g. `projects/saa/game`. */
  workspaceDir: string;
  checkoutPath?: string;
  gitRemote?: string;
  defaultBranch?: string;
  /** Branch captured in the snapshot. */
  branch?: string;
  /** HEAD short hash captured in the snapshot. */
  head?: string;
  tasks: TaskBrief[];
  recentDocs: { path: string; title: string }[];
}

/** Frozen workspace facts taken when the session is created. */
export interface WorkspaceSnapshot {
  takenAt: string;
  deviceName: string;
  /** Full text of the workspace root `AGENTS.md`. */
  agents: string;
  /** Full text of `memories/INDEX.md`. */
  memoryIndex: string;
  builtinTasks: TaskBrief[];
  projects: ProjectSnapshot[];
}

export interface SessionCreatedEvent extends LedgerEventBase {
  type: 'session.created';
  workspaceRoot: string;
  snapshot: WorkspaceSnapshot;
}

export interface TurnStartedEvent extends LedgerEventBase {
  type: 'turn.started';
  text: string;
  model: TurnModel;
}

/**
 * Marks the start of one reasoning cycle. It is appended before the cycle's
 * request is assembled and rendered as that cycle's `<wy-info>` line, so the
 * per-request facts are part of the append-only context instead of a block
 * rewritten on every request.
 */
export interface CycleStartedEvent extends LedgerEventBase {
  type: 'cycle.started';
  /** Main model public id serving this cycle. */
  model: string;
  contextWindow?: number;
  /** Upstream-reported input tokens of the previous reasoning request, when known. */
  lastInputTokens?: number;
}

export interface ThinkingEvent extends LedgerEventBase {
  type: 'thinking';
  callId: string;
  text: string;
}

/** One document pick in a doc-search result. */
export interface DocPick {
  path: string;
  title: string;
  reason: string;
}

export interface DocSearchEvent extends LedgerEventBase {
  type: 'doc.search';
  actionId: string;
  understanding: string;
  picks: DocPick[];
  near: DocPick[];
  notes: string[];
}

export interface DocContentEvent extends LedgerEventBase {
  type: 'doc.content';
  path: string;
  title: string;
  updated: string;
  version: string;
  tokens: number;
  content: string;
  format: 'full' | 'diff';
  base?: string;
  source: 'read' | 'write' | 'project-instructions';
  actionId?: string;
}

export interface FilesEvent extends LedgerEventBase {
  type: 'files';
  source: 'user' | 'task' | 'read';
  files: SessionFile[];
  actionId?: string;
  taskRunId?: string;
}

export interface MemoryRecalledEvent extends LedgerEventBase {
  type: 'memory.recalled';
  version: string;
  source: 'memory-search' | 'read';
  actionId?: string;
  path: string;
  content: string;
}

export interface ReasonCompletedEvent extends LedgerEventBase {
  type: 'reason.completed';
  callId: string;
  text: string;
  /**
   * The complete worker output of this cycle: the visible prose plus the
   * ordered raw action intents and questions parsed from its wy_action tool
   * calls. The communication view renders this; `text` stays the main reasoning
   * prose so main reasoning rendering is unchanged.
   */
  workerOutput?: string;
}

export interface ActionStartedEvent extends LedgerEventBase {
  type: 'action.started';
  actionId: string;
  kind: ActionKind;
  /** The parsed action payload; opaque here because `actions.ts` owns its shape. */
  parsed: unknown;
  taskRunId?: string;
}

export interface ActionTitledEvent extends LedgerEventBase {
  type: 'action.titled';
  actionId: string;
  title: string;
}

export interface ActionFinishedEvent extends LedgerEventBase {
  task?: string;
  taskStatus?: string;
  type: 'action.finished';
  actionId: string;
  kind: ActionKind;
  status: ActionStatus;
  result: string;
  taskRunId?: string;
  afterInterrupt?: boolean;
}

export interface ReplyEvent extends LedgerEventBase {
  type: 'reply';
  text: string;
  callId?: string;
}

export interface WsUpdatedEvent extends LedgerEventBase {
  type: 'ws.updated';
  actionId: string;
  scope: 'document' | 'workspace' | 'project';
  target: string;
  change: 'created' | 'updated' | 'committed' | 'pushed' | 'pulled' | 'worktree-created' | 'worktree-removed' | 'worktree-merged' | 'registered' | 'deleted';
  worktreeId?: string;
  version?: string;
  hash?: string;
  files?: string[];
}

export interface TurnInterruptedEvent extends LedgerEventBase {
  type: 'turn.interrupted';
  reason: 'user' | 'shutdown' | 'restart';
}

export interface TurnFinishedEvent extends LedgerEventBase {
  type: 'turn.finished';
  status: TurnStatus;
  error?: string;
}

export interface TitleEvent extends LedgerEventBase {
  type: 'title';
  text: string;
  callId: string;
}

/**
 * Observational marker appended when a call is actually issued. It never enters
 * the rendered model context (it is not a context event), so appending it cannot
 * change any previously rendered result. The matching `call` event carries the
 * same `callId`.
 */
export interface CallStartedEvent extends LedgerEventBase {
  type: 'call.started';
  callId: string;
  role: CallRole;
  /** Gateway public id, always exactly `provider/model`. */
  model: string;
}

export interface CallEvent extends LedgerEventBase {
  type: 'call';
  callId: string;
  role: CallRole;
  /** Gateway public id, always exactly `provider/model`. */
  model: string;
  status: 'ok' | 'failed' | 'aborted';
  startedAt: string;
  endedAt: string;
  /** When the driver first produced a nonempty delta (visible or reasoning). */
  firstTokenAt?: string;
  /** Character count per prompt layer, e.g. `{ 'wy-system': 1234 }`. */
  layers: Record<string, number>;
  estimatedInputTokens: number;
  usage?: Usage;
  /** Visible output; partial output when the call was aborted or interrupted. */
  output: string;
  reasoning?: string;
  /** Public reasoning level actually sent for this attempt. */
  reasoningEffort?: ReasoningEffort;
  /** The explicitly requested level, or an auxiliary role's declared expectation. */
  requestedReasoningEffort?: string;
  /** Rank of the route that served (or last attempted) an auxiliary call. */
  selectedRank?: number;
  /** Every route tried or skipped, in order. */
  routeAttempts?: readonly import('./calls.ts').CallRouteAttempt[];
  /** Ordered auxiliary routes retained for this invocation. */
  routeCandidates?: readonly import('./calls.ts').AuxiliaryRoute[];
  error?: string;
}

export interface ErrorEvent extends LedgerEventBase {
  type: 'error';
  stage: string;
  message: string;
}

export type LedgerEvent =
  | SessionCreatedEvent
  | TurnStartedEvent
  | CycleStartedEvent
  | ThinkingEvent
  | DocSearchEvent
  | DocContentEvent
  | FilesEvent
  | MemoryRecalledEvent
  | ReasonCompletedEvent
  | ActionStartedEvent
  | ActionTitledEvent
  | ActionFinishedEvent
  | ReplyEvent
  | WsUpdatedEvent
  | TurnInterruptedEvent
  | TurnFinishedEvent
  | TitleEvent
  | CallStartedEvent
  | CallEvent
  | ErrorEvent;

/** An event body without the `seq` / `at` the ledger assigns on append. */
type WithoutSequence<T> = T extends LedgerEventBase ? Omit<T, 'seq' | 'at'> : never;

/** Discriminated distributively, so each member narrows on `type`. */
export type LedgerEventDraft = WithoutSequence<LedgerEvent>;

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

// ─── Ledger ────────────────────────────────────────────────────────────────

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
    if (event.type === 'title' && event.text.trim() !== '') title = event.text.trim();
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

/**
 * Every distinct session file a timeline records through `files` events, keyed
 * by path + hash, with the latest record kept and first-seen timeline order.
 */
export function collectSessionFiles(events: readonly LedgerEvent[]): SessionFile[] {
  const files = new Map<string, SessionFile>();
  for (const event of events) {
    if (event.type !== 'files') continue;
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
    if (event.type !== 'files') continue;
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
    if (event.type === 'title' && event.text.trim() !== '') title = event.text.trim();
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
