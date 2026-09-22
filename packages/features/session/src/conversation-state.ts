import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ConversationItemSnapshot,
  TaskRunSnapshot,
  TaskRunSpeedEvidence,
  TaskRunUsage,
} from '@wrenyard/protocol/session';

/**
 * Persisted product-owned conversation document.
 *
 * DSH's own session store is the execution log for one *branch* of one user
 * turn; it is linear only inside a single session and cannot express the
 * product's parallel, linear conversation. Desktop therefore owns this small
 * document: every independent logical conversation the workspace has ever
 * started (each keyed by its own stable root session id), the ordered
 * messages the user actually sees in it, the mapping from each of its logical
 * turns to the execution session that ran it, and its frozen terminal
 * per-turn telemetry. Session ids are recorded for lineage/diagnostics only —
 * display state is never derived from them.
 *
 * The version is only raised by a change that makes an older document
 * unreadable. Owned task runs, handled internal boundaries, and the latest
 * progress note are additive optional fields, so a document written before
 * them still loads — the turn simply restores with no dispatched tasks.
 */
export const CONVERSATION_STATE_VERSION = 2;

/** One user or assistant message of one conversation's linear transcript. */
export interface ConversationStateMessage {
  id: string;
  kind: 'user' | 'assistant';
  text: string;
  /** Time the message became part of the conversation (send or completion). */
  time: number;
}

/**
 * One process item of a turn's own execution branch: exactly the assistant or
 * tool record the renderer shows inside the turn's process block, including
 * tool arguments, bounded results, and terminal task-run metadata. The complete
 * chronological process is persisted, not only its concatenated text, so a
 * restored turn still shows the work that produced its answer.
 */
export type ConversationStateProcessItem = ConversationItemSnapshot;

/** Model choice captured at send time for one turn. */
export interface ConversationStateModel {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/**
 * Lifecycle of one task run a work turn dispatched and owns:
 *
 * - `pending`  — dispatched; its authoritative result has not arrived yet.
 * - `ready`    — the terminal result arrived and has not been delivered to the
 *   model yet.
 * - `consumed` — the result was delivered to the owning execution session
 *   exactly once, so it is never resent.
 */
export type ConversationStateTaskStatus = 'pending' | 'ready' | 'consumed';

/**
 * One task run a work turn dispatched and owns. Persisted so a restart can
 * report the truthful state of every dispatch instead of silently dropping it
 * or implying an outcome that was never observed.
 */
export interface ConversationStateTask {
  taskRunId: string;
  status: ConversationStateTaskStatus;
  /** DSH tool call that dispatched this run, used to re-attach its metadata. */
  callId?: string;
  /** Authoritative terminal projection, once the run resolved. */
  taskRun?: TaskRunSnapshot;
}

/**
 * Frozen terminal telemetry of one user turn. Every optional number stays
 * absent when DSH never observed the datum.
 */
export interface ConversationStateTurn {
  /** Stable product turn identity, used by the renderer's per-turn cancel. */
  id: string;
  /** Ordering key of the turn inside its own conversation's linear transcript. */
  seq: number;
  /** The user message that opened this turn. */
  userItemId: string;
  /** The execution session that ran this turn's branch. */
  executionSessionId: string;
  /** The completed session this turn forked from, when there was one. */
  forkParentSessionId?: string;
  /** Inclusive `session.fork` cut passed as `atSeq`, when it was known. */
  forkAtSeq?: number;
  /** Session a later turn of the same conversation forks from. */
  baseSessionId?: string;
  /** Inclusive anchor inside `baseSessionId` observed when this turn completed. */
  baseAtSeq?: number;
  /**
   * Send-seqs of the earlier completed turns whose visible exchanges this
   * turn's branch already contains (inherited through its fork cut or
   * injected at dispatch), so a later fork never injects an exchange twice.
   */
  coveredTurnSeqs?: number[];
  /** Terminal assistant message of this turn, once it completed. */
  finalItemId?: string;
  /**
   * Highest event seq the branch inherited from its fork cut. Frozen at fork
   * time; events at or below it are the forked-from history, never this turn's.
   */
  inheritedMaxSeq?: number;
  /** Exact `turn/end` time of this turn's own branch, when one was observed. */
  dshEndedAt?: number;
  /** The turn's own chronological process items, kept verbatim across restarts. */
  process?: ConversationStateProcessItem[];
  /** The complete DSH text of this turn's branch, kept as summarizer context. */
  work?: string;
  /** The summary produced for this turn, when a summarizer was configured. */
  summary?: string;
  /**
   * Latest progress note of a work turn that was still waiting on its own
   * dispatched tasks. It is never a transcript message: it is replaced by the
   * final summary and never appended next to it.
   */
  progress?: string;
  /** Task runs this work turn dispatched and owns, with their exact states. */
  tasks?: ConversationStateTask[];
  /**
   * Internal DSH turn identities of this work turn whose end was already
   * handled. A replayed or reconnected `turn/end` therefore cannot reopen a
   * boundary, duplicate a progress note, or resend a task result.
   */
  internalTurnIds?: string[];
  /** Model this turn was sent with, so a restored turn keeps its own choice. */
  model?: ConversationStateModel;
  /** Observed `run_task`/`task_run` dispatches; frozen with the turn. */
  dispatchCount?: number;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: number;
  endedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  outputTps?: number;
  /** Visible concise error when a turn failed; never the raw work text. */
  error?: string;
}

/**
 * One independent logical conversation. Keyed by its own stable identity: the
 * DSH root session id once that exists, or the synthetic local id the
 * conversation was started with before its first send created one. The
 * identity is stable for the conversation's whole lifetime, even though
 * individual turns fork and use their own execution sessions.
 */
export interface ConversationStateRecord {
  id: string;
  /** DSH session that anchors this conversation, when one was established. */
  rootSessionId?: string;
  messages: ConversationStateMessage[];
  turns: ConversationStateTurn[];
  /** Summary context the newest turn was sent with; only previous turns appear. */
  summaries: Array<{ user: string; summary: string }>;
}

export interface ConversationStateDocument {
  version: number;
  /**
   * Workspace the document belongs to. A document whose scope does not match
   * the active workspace is ignored entirely.
   */
  workspaceScope: string;
  /** Every conversation this workspace has started, independent of each other. */
  records: ConversationStateRecord[];
  /** The conversation selected in the UI when the document was last saved. */
  selectedRecordId?: string;
  /** Monotonic turn counter shared by every conversation, so restored ids never collide with new ones. */
  nextSeq: number;
}

export interface ConversationStateStoreOptions {
  path: string;
  /** Stable identifier of the owning workspace; mismatched documents are ignored. */
  workspaceScope: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeMessage(value: unknown): ConversationStateMessage | undefined {
  if (!isObject(value)) return undefined;
  const id = optionalString(value.id);
  const text = typeof value.text === 'string' ? value.text : undefined;
  const time = optionalNumber(value.time);
  if (!id || text === undefined || time === undefined) return undefined;
  if (value.kind !== 'user' && value.kind !== 'assistant') return undefined;
  return { id, kind: value.kind, text, time };
}

function normalizeModel(value: unknown): ConversationStateModel | undefined {
  if (!isObject(value)) return undefined;
  const provider = optionalString(value.provider);
  const model = optionalString(value.model);
  if (!provider || !model) return undefined;
  const reasoningEffort = optionalString(value.reasoningEffort);
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

function normalizeTaskRunSpeed(value: unknown): TaskRunSpeedEvidence | undefined {
  if (!isObject(value)) return undefined;
  const effectiveTps = optionalNumber(value.effectiveTps);
  const source = value.source;
  if (effectiveTps === undefined) return undefined;
  if (source !== 'local_31d' && source !== 'provider_override' && source !== 'catalog_default') return undefined;
  const sampleCount = optionalNumber(value.sampleCount);
  const degradationReason = optionalString(value.degradationReason);
  return {
    effectiveTps,
    source,
    sampleCount: sampleCount === undefined ? null : sampleCount,
    expectedTpsMet: typeof value.expectedTpsMet === 'boolean' ? value.expectedTpsMet : null,
    ...(degradationReason ? { degradationReason } : {}),
  };
}

/** Optional numeric fields of a persisted task-run usage projection. */
const TASK_RUN_USAGE_NUMBERS = [
  'inputTokens',
  'cachedInputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'outputTokens',
  'totalTokens',
  'generationMs',
  'outputTps',
  'referenceCostUsd',
] as const;

function normalizeTaskRunUsage(value: unknown): TaskRunUsage | undefined {
  if (!isObject(value)) return undefined;
  const completeness = value.completeness;
  if (completeness !== 'complete' && completeness !== 'partial' && completeness !== 'unavailable') return undefined;
  const attemptCount = optionalNumber(value.attemptCount);
  const usageEventCount = optionalNumber(value.usageEventCount);
  if (attemptCount === undefined || usageEventCount === undefined) return undefined;
  const usage: TaskRunUsage = {
    completeness,
    attemptCount,
    usageEventCount,
    referenceCostComplete: value.referenceCostComplete === true,
  };
  for (const key of TASK_RUN_USAGE_NUMBERS) {
    const numeric = optionalNumber(value[key]);
    if (numeric !== undefined) usage[key] = numeric;
  }
  if (value.tpsContract === 'tokenizer_v1') usage.tpsContract = 'tokenizer_v1';
  const referenceCostBasis = optionalString(value.referenceCostBasis);
  if (referenceCostBasis) usage.referenceCostBasis = referenceCostBasis;
  return usage;
}

/** Optional string fields of a persisted task-run projection. */
const TASK_RUN_STRINGS = [
  'taskName',
  'project',
  'startedAt',
  'finishedAt',
  'resolvedClient',
  'resolvedProvider',
  'resolvedProfile',
  'resolvedModel',
  'resolvedModelId',
  'resolvedProviderDisplayName',
  'resolvedModelDisplayName',
] as const;

/**
 * Restore the terminal task-run metadata of one persisted tool item. Identity
 * and usage are mandatory, so a partially written run is dropped whole rather
 * than restored as a run with fabricated fields.
 */
function normalizeTaskRun(value: unknown): TaskRunSnapshot | undefined {
  if (!isObject(value)) return undefined;
  const taskRunId = optionalString(value.taskRunId);
  const taskId = optionalString(value.taskId);
  const usage = normalizeTaskRunUsage(value.usage);
  if (!taskRunId || !taskId || !usage) return undefined;
  const run: TaskRunSnapshot = { taskRunId, taskId, usage };
  for (const key of TASK_RUN_STRINGS) {
    const text = optionalString(value[key]);
    if (text) run[key] = text;
  }
  const source = value.source;
  if (source === 'builtin' || source === 'project' || source === 'unknown') run.source = source;
  const status = value.status;
  if (status === 'done' || status === 'failed' || status === 'cancelled'
    || status === 'interrupted' || status === 'running' || status === 'queued') {
    run.status = status;
  }
  const speed = normalizeTaskRunSpeed(value.speed);
  if (speed) run.speed = speed;
  return run;
}

function normalizeDocumentLinks(value: unknown): Array<{ title: string; path: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const links: Array<{ title: string; path: string }> = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const title = optionalString(entry.title);
    const path = optionalString(entry.path);
    if (title && path) links.push({ title, path });
  }
  return links.length > 0 ? links : undefined;
}

/**
 * Restore one persisted process item field by field. A frozen item is never
 * running, so that transient flag is not restored; everything the renderer
 * needs to rebuild the collapsed process block is.
 */
function normalizeProcessItem(value: unknown): ConversationStateProcessItem | undefined {
  if (!isObject(value)) return undefined;
  const id = optionalString(value.id);
  const text = typeof value.text === 'string' ? value.text : undefined;
  const time = optionalNumber(value.time);
  const kind = value.kind;
  if (!id || text === undefined || time === undefined) return undefined;
  if (kind !== 'user' && kind !== 'assistant' && kind !== 'tool') return undefined;
  const item: ConversationStateProcessItem = { id, kind, text, time };
  const turnId = optionalString(value.turnId);
  if (turnId) item.turnId = turnId;
  const toolName = optionalString(value.toolName);
  if (toolName) item.toolName = toolName;
  const toolState = value.toolState;
  if (toolState === 'running' || toolState === 'done' || toolState === 'failed') item.toolState = toolState;
  const toolResultText = optionalString(value.toolResultText);
  if (toolResultText) item.toolResultText = toolResultText;
  const toolSummary = optionalString(value.toolSummary);
  if (toolSummary) item.toolSummary = toolSummary;
  const step = optionalNumber(value.step);
  if (step !== undefined) item.step = step;
  const taskRun = normalizeTaskRun(value.taskRun);
  if (taskRun) item.taskRun = taskRun;
  const documentLinks = normalizeDocumentLinks(value.documentLinks);
  if (documentLinks) item.documentLinks = documentLinks;
  return item;
}

function normalizeProcess(value: unknown): ConversationStateProcessItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeProcessItem)
    .filter((item): item is ConversationStateProcessItem => item !== undefined);
}

/**
 * Restore one owned task run. An entry without its run identity cannot be
 * re-attached or truthfully reported, so it is dropped whole; a `pending` entry
 * stays pending because a restart never observed an outcome for it.
 */
function normalizeTask(value: unknown): ConversationStateTask | undefined {
  if (!isObject(value)) return undefined;
  const taskRunId = optionalString(value.taskRunId);
  if (!taskRunId) return undefined;
  const status = value.status === 'ready' || value.status === 'consumed' ? value.status : 'pending';
  const callId = optionalString(value.callId);
  const taskRun = normalizeTaskRun(value.taskRun);
  return {
    taskRunId,
    status,
    ...(callId ? { callId } : {}),
    ...(taskRun ? { taskRun } : {}),
  };
}

function normalizeTasks(value: unknown): ConversationStateTask[] {
  if (!Array.isArray(value)) return [];
  const tasks: ConversationStateTask[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const task = normalizeTask(entry);
    if (!task || seen.has(task.taskRunId)) continue;
    seen.add(task.taskRunId);
    tasks.push(task);
  }
  return tasks;
}

function normalizeInternalTurnIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    const id = optionalString(entry);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Restore the persisted per-turn ancestry as a sorted, de-duplicated seq list. */
function normalizeCoveredTurnSeqs(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seqs = value
    .map(optionalNumber)
    .filter((seq): seq is number => seq !== undefined);
  return seqs.length > 0 ? [...new Set(seqs)].sort((left, right) => left - right) : undefined;
}

function normalizeTurn(value: unknown): ConversationStateTurn | undefined {
  if (!isObject(value)) return undefined;
  const id = optionalString(value.id);
  const userItemId = optionalString(value.userItemId);
  const executionSessionId = typeof value.executionSessionId === 'string' ? value.executionSessionId : '';
  const seq = optionalNumber(value.seq);
  const startedAt = optionalNumber(value.startedAt);
  if (!id || !userItemId || seq === undefined || startedAt === undefined) return undefined;
  const status = value.status === 'completed' || value.status === 'cancelled' || value.status === 'failed'
    ? value.status
    : 'running';
  const inheritedMaxSeq = optionalNumber(value.inheritedMaxSeq);
  const dshEndedAt = optionalNumber(value.dshEndedAt);
  const process = normalizeProcess(value.process);
  const tasks = normalizeTasks(value.tasks);
  const internalTurnIds = normalizeInternalTurnIds(value.internalTurnIds);
  const coveredTurnSeqs = normalizeCoveredTurnSeqs(value.coveredTurnSeqs);
  return {
    id,
    seq,
    userItemId,
    executionSessionId,
    ...(optionalString(value.forkParentSessionId) ? { forkParentSessionId: value.forkParentSessionId as string } : {}),
    ...(optionalNumber(value.forkAtSeq) !== undefined ? { forkAtSeq: value.forkAtSeq as number } : {}),
    ...(optionalString(value.baseSessionId) ? { baseSessionId: value.baseSessionId as string } : {}),
    ...(optionalNumber(value.baseAtSeq) !== undefined ? { baseAtSeq: value.baseAtSeq as number } : {}),
    ...(coveredTurnSeqs ? { coveredTurnSeqs } : {}),
    ...(optionalString(value.finalItemId) ? { finalItemId: value.finalItemId as string } : {}),
    ...(inheritedMaxSeq !== undefined ? { inheritedMaxSeq } : {}),
    ...(dshEndedAt !== undefined ? { dshEndedAt } : {}),
    ...(process.length > 0 ? { process } : {}),
    ...(optionalString(value.work) ? { work: value.work as string } : {}),
    ...(optionalString(value.summary) ? { summary: value.summary as string } : {}),
    ...(optionalString(value.progress) ? { progress: value.progress as string } : {}),
    ...(tasks.length > 0 ? { tasks } : {}),
    ...(internalTurnIds.length > 0 ? { internalTurnIds } : {}),
    ...(() => {
      const model = normalizeModel(value.model);
      return model ? { model } : {};
    })(),
    ...(optionalNumber(value.dispatchCount) !== undefined ? { dispatchCount: value.dispatchCount as number } : {}),
    status,
    startedAt,
    ...(optionalNumber(value.endedAt) !== undefined ? { endedAt: value.endedAt as number } : {}),
    ...(optionalNumber(value.inputTokens) !== undefined ? { inputTokens: value.inputTokens as number } : {}),
    ...(optionalNumber(value.outputTokens) !== undefined ? { outputTokens: value.outputTokens as number } : {}),
    ...(optionalNumber(value.outputTps) !== undefined ? { outputTps: value.outputTps as number } : {}),
    ...(optionalString(value.error) ? { error: value.error as string } : {}),
  };
}

function normalizeSummaries(value: unknown): Array<{ user: string; summary: string }> {
  if (!Array.isArray(value)) return [];
  const summaries: Array<{ user: string; summary: string }> = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const user = optionalString(item.user);
    const summary = optionalString(item.summary);
    if (user && summary) summaries.push({ user, summary });
  }
  return summaries;
}

/**
 * Normalize one persisted conversation record. Only a record that still
 * carries its stable identity is kept — an id-less entry cannot be
 * reattached to any DSH session and is therefore dropped rather than guessed.
 */
function normalizeRecord(value: unknown): ConversationStateRecord | undefined {
  if (!isObject(value)) return undefined;
  const id = optionalString(value.id);
  if (!id) return undefined;
  const messages = Array.isArray(value.messages)
    ? value.messages.map(normalizeMessage).filter((message): message is ConversationStateMessage => message !== undefined)
    : [];
  const turns = Array.isArray(value.turns)
    ? value.turns.map(normalizeTurn).filter((turn): turn is ConversationStateTurn => turn !== undefined)
    : [];
  const rootSessionId = optionalString(value.rootSessionId);
  return {
    id,
    ...(rootSessionId ? { rootSessionId } : {}),
    messages,
    turns,
    summaries: normalizeSummaries(value.summaries),
  };
}

/**
 * Parse a persisted document defensively. Anything that is not a document of
 * this exact version and workspace scope is discarded — a legacy or foreign
 * file must never fail a start, and a partially corrupted file degrades to the
 * fields that are still readable rather than to fabricated history.
 */
export function parseConversationState(
  raw: unknown,
  workspaceScope: string,
): ConversationStateDocument | undefined {
  if (!isObject(raw) || raw.version !== CONVERSATION_STATE_VERSION) return undefined;
  if (raw.workspaceScope !== workspaceScope) return undefined;
  const records = (Array.isArray(raw.records) ? raw.records : [])
    .map(normalizeRecord)
    .filter((record): record is ConversationStateRecord => record !== undefined);
  // The turn counter is shared by every conversation, so a restored id can
  // never collide with one minted after the restore.
  const seqs = records.flatMap((record) => record.turns.map((turn) => turn.seq));
  const declared = optionalNumber(raw.nextSeq) ?? 0;
  const nextSeq = Math.max(declared, ...seqs.map((value) => value + 1), 0);
  const selectedRecordId = optionalString(raw.selectedRecordId);
  return {
    version: CONVERSATION_STATE_VERSION,
    workspaceScope,
    records,
    ...(selectedRecordId && records.some((record) => record.id === selectedRecordId) ? { selectedRecordId } : {}),
    nextSeq,
  };
}

export function emptyConversationState(workspaceScope: string): ConversationStateDocument {
  return {
    version: CONVERSATION_STATE_VERSION,
    workspaceScope,
    records: [],
    nextSeq: 0,
  };
}

/**
 * Load and atomically persist the product-owned conversation document. Reads
 * are best-effort: a missing, unreadable, malformed, or foreign-scoped file
 * yields an empty document instead of an error, so ordinary legacy DSH
 * sessions keep restoring safely.
 */
export class ConversationStateStore {
  private readonly path: string;
  private readonly workspaceScope: string;

  constructor(options: ConversationStateStoreOptions) {
    this.path = options.path;
    this.workspaceScope = options.workspaceScope;
  }

  load(): ConversationStateDocument {
    if (!existsSync(this.path)) return emptyConversationState(this.workspaceScope);
    try {
      const parsed = parseConversationState(JSON.parse(readFileSync(this.path, 'utf8')) as unknown, this.workspaceScope);
      return parsed ?? emptyConversationState(this.workspaceScope);
    } catch {
      return emptyConversationState(this.workspaceScope);
    }
  }

  /**
   * Serializable snapshot of the live document. Every conversation, message,
   * and turn is retained: dropping a conversation or a turn would silently
   * destroy work the user can still select, so the document grows with the
   * workspace instead of being truncated at an arbitrary count.
   */
  snapshot(document: ConversationStateDocument): ConversationStateDocument {
    const records = document.records.map((record) => ({
      id: record.id,
      ...(record.rootSessionId ? { rootSessionId: record.rootSessionId } : {}),
      messages: [...record.messages],
      turns: [...record.turns],
      summaries: [...record.summaries],
    }));
    return {
      version: CONVERSATION_STATE_VERSION,
      workspaceScope: this.workspaceScope,
      records,
      ...(document.selectedRecordId && records.some((record) => record.id === document.selectedRecordId)
        ? { selectedRecordId: document.selectedRecordId }
        : {}),
      nextSeq: document.nextSeq,
    };
  }

  /**
   * Persist through a same-directory temporary file and a rename, so a crash
   * can never leave a half-written document behind. The file is written with
   * owner-only permissions since it may carry private conversation content.
   *
   * A write failure is propagated rather than swallowed: the caller owns the
   * decision to keep the live conversation running while surfacing the failure
   * to the user, and a silently lost document would look like working
   * persistence until the next restart.
   */
  save(document: ConversationStateDocument): void {
    const snapshot = this.snapshot(document);
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
