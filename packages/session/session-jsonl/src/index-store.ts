import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LedgerEvent, SessionSummary } from '@wrenyard/protocol/session';

export const DEFAULT_TITLE = '新会话';
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
export const INDEX_WRITE_DEBOUNCE_MS = 250;

interface LedgerIndexFile {
  sessions: SessionSummary[];
}

export interface FailedSpanFacts {
  errorKind: string;
  errorMessage: string;
  retryAt?: string;
}

export function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`invalid session id: ${sessionId}`);
  }
}

export class SessionIndexStore {
  private readonly summaries = new Map<string, SessionSummary>();
  private readonly staleSummaries = new Set<string>();
  private writeChain: Promise<unknown> = Promise.resolve();
  private indexTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly sessionsDir: string,
    private readonly indexPath: string,
  ) {}

  get(sessionId: string): SessionSummary | undefined {
    const summary = this.summaries.get(sessionId);
    return summary === undefined ? undefined : copySummary(summary);
  }

  has(sessionId: string): boolean {
    return this.summaries.has(sessionId);
  }

  isStale(sessionId: string): boolean {
    return this.staleSummaries.has(sessionId);
  }

  markStale(sessionId: string): void {
    this.staleSummaries.add(sessionId);
  }

  set(sessionId: string, summary: SessionSummary): void {
    this.summaries.set(sessionId, copySummary(summary));
    this.staleSummaries.delete(sessionId);
  }

  delete(sessionId: string): void {
    this.summaries.delete(sessionId);
    this.staleSummaries.delete(sessionId);
  }

  list(): SessionSummary[] {
    return [...this.summaries.values()]
      .map((summary) => copySummary(summary))
      .sort((a, b) => {
        if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
        return a.sessionId.localeCompare(b.sessionId);
      });
  }

  loadIndexSync(): void {
    this.summaries.clear();
    this.staleSummaries.clear();
    if (!existsSync(this.indexPath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.indexPath, 'utf8'));
      const sessions = (parsed as { sessions?: unknown } | null)?.sessions;
      if (!Array.isArray(sessions)) return;
      for (const item of sessions) {
        const summary = readSummary(item);
        if (summary !== undefined) {
          this.summaries.set(summary.sessionId, summary);
          this.staleSummaries.add(summary.sessionId);
        }
      }
    } catch {
      this.summaries.clear();
      this.staleSummaries.clear();
    }
  }

  /**
   * Reconcile the index with `sessions/*.jsonl` using filenames and file stats
   * only. Never reads JSONL bodies at startup.
   */
  reconcileIndexSync(): void {
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
      const complete = summary.lastSeq !== undefined && summary.pendingTurns !== undefined;
      if (complete && summary.bytes === stat.size) {
        this.staleSummaries.delete(sessionId);
        continue;
      }
      delete summary.lastSeq;
      delete summary.pendingTurns;
      summary.bytes = stat.size;
      this.staleSummaries.add(sessionId);
    }

    if (previous !== JSON.stringify(this.indexFile())) {
      this.writeIndexSync();
    }
  }

  applySummary(
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
    if (titled !== undefined && (!manualTitle || titled.manual)) {
      title = titled.title;
      manualTitle = titled.manual;
    }
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

  rebuildSummaryIfNeeded(
    sessionId: string,
    events: readonly LedgerEvent[],
    bytes: number,
  ): void {
    const existing = this.summaries.get(sessionId);
    if (existing !== undefined && !this.staleSummaries.has(sessionId)) {
      if (existing.bytes !== bytes) {
        existing.bytes = bytes;
        this.scheduleIndexWrite();
      }
      return;
    }
    if (events.length === 0) {
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

  scheduleIndexWrite(): void {
    if (this.indexTimer !== undefined) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = undefined;
      void this.flushIndex().catch(() => undefined);
    }, INDEX_WRITE_DEBOUNCE_MS);
    this.indexTimer.unref();
  }

  cancelIndexTimer(): void {
    if (this.indexTimer === undefined) return;
    clearTimeout(this.indexTimer);
    this.indexTimer = undefined;
  }

  flushIndex(): Promise<void> {
    this.cancelIndexTimer();
    const run = this.writeChain.then(() => this.writeIndexAtomic());
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  writeIndexSync(): void {
    const data = `${JSON.stringify(this.indexFile(), null, 2)}\n`;
    const temp = `${this.indexPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    writeFileSync(temp, data, 'utf8');
    renameSync(temp, this.indexPath);
  }

  private async writeIndexAtomic(): Promise<void> {
    const data = `${JSON.stringify(this.indexFile(), null, 2)}\n`;
    const temp = `${this.indexPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      const handle = await open(temp, 'w');
      try {
        await handle.writeFile(data, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.indexPath);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private indexFile(): LedgerIndexFile {
    return {
      sessions: [...this.summaries.values()].map((summary) => copySummary(summary)),
    };
  }
}

function copySummary(summary: SessionSummary): SessionSummary {
  return {
    ...summary,
    ...(summary.lastTurn === undefined ? {} : { lastTurn: { ...summary.lastTurn } }),
    ...(summary.pendingTurns === undefined ? {} : { pendingTurns: [...summary.pendingTurns] }),
  };
}

function titleOfEvent(event: LedgerEvent): { title: string; manual: boolean } | undefined {
  if (event.type !== 'session.titled') return undefined;
  const title = event.text.trim();
  return title === '' ? undefined : { title, manual: event.manual === true };
}

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

export function failedSpanFacts(
  events: readonly LedgerEvent[],
  bound: number,
  turn: number,
): FailedSpanFacts | undefined {
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

export function lastTurnAfter(
  previous: SessionSummary['lastTurn'],
  event: LedgerEvent,
  events: readonly LedgerEvent[],
  bound: number,
): SessionSummary['lastTurn'] {
  switch (event.type) {
    case 'turn.started':
      return undefined;
    case 'turn.finished': {
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
        ...(event.status === 'failed' && failed === undefined && event.error !== undefined
          ? { errorMessage: event.error }
          : {}),
      };
    }
    case 'turn.attention':
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

export function summarize(sessionId: string, events: readonly LedgerEvent[]): SessionSummary {
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
    if (event.type === 'session.metadata') {
      if (event.archived !== undefined) archived = event.archived;
      if (event.pinned !== undefined) pinned = event.pinned;
    }
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

export function readSummary(value: unknown): SessionSummary | undefined {
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

function readLastTurn(value: unknown): SessionSummary['lastTurn'] | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== 'completed' && status !== 'failed' && status !== 'interrupted') return undefined;
  const finishedAt = record.finishedAt;
  const turn = record.turn;
  if (typeof finishedAt !== 'string' || typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1) {
    return undefined;
  }
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

export function pendingTurnsOf(events: readonly LedgerEvent[]): number[] {
  const started = new Set<number>();
  const finished = new Set<number>();
  for (const event of events) {
    if (typeof event.turn !== 'number') continue;
    if (event.type === 'turn.started') started.add(event.turn);
    else if (event.type === 'turn.finished') finished.add(event.turn);
  }
  return [...started].filter((turn) => !finished.has(turn)).sort((left, right) => left - right);
}

export function pendingTurnsAfter(
  previous: readonly number[] | undefined,
  event: LedgerEvent,
): number[] {
  const turns = new Set(previous ?? []);
  if (typeof event.turn === 'number') {
    if (event.type === 'turn.started') turns.add(event.turn);
    else if (event.type === 'turn.finished') turns.delete(event.turn);
  }
  return [...turns].sort((left, right) => left - right);
}

export function isLifecycleEvent(event: LedgerEvent): boolean {
  return event.type === 'session.created'
    || event.type === 'turn.started'
    || event.type === 'turn.interrupted'
    || event.type === 'turn.finished';
}
