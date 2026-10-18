import type {
  ActionFinishedEvent,
  ActionStartedEvent,
  ActionStatus,
  ActionTitledEvent,
  DocumentContentEvent,
  DocumentFoundEvent,
  ReplySentEvent,
  SystemNoticeEvent,
  FilesAttachedEvent,
  LedgerEvent,
  MemoryRecalledEvent,
  ModelSpanFinishedEvent,
  ModelSpanStartedEvent,
  ReasoningCompletedEvent,
  ReasoningThinkingEvent,
  SpanContextEvent,
  SpanError,
  SpanFinishedEvent,
  SpanStartedEvent,
  TurnFinishedEvent,
  TurnInterruptedEvent,
  TurnStartedEvent,
  WorkspaceChangedEvent,
  WorkspaceSnapshot,
} from '@wrenyard/session';
import { actionLabel } from './describe.js';
import type {
  ActionModel,
  CallContextSnapshot,
  CallModel,
  ContextItem,
  CycleModel,
  ErrorItem,
  ItemStatus,
  LiveCall,
  Phase,
  ReplyModel,
  SessionBridgeTaskBrief,
  SessionFile,
  SessionModel,
  TurnModel,
  TurnStats,
  TurnStatus,
} from './types.js';

export interface FoldOptions {
  sessionId?: string;
  /** Turn ids whose interrupt has been requested but not yet acknowledged. */
  interrupting?: readonly number[];
}

/** One-line failure text of a span's structured error fact. */
function spanErrorText(error: SpanError): string {
  const status = error.status === undefined ? '' : ` (HTTP ${error.status})`;
  return `${error.message}${status}`;
}

/** The attempt list of a finished model span, derived from its metrics. */
type SpanAttempts = NonNullable<ModelSpanFinishedEvent['metrics']>['attempts'];

/**
 * Same-route retries the transport performed. Every failed attempt yields one
 * retry whose delay is the wait before the next request.
 */
function retriesOf(attempts: SpanAttempts): { status?: number; kind: string; delayMs: number }[] {
  const retries: { status?: number; kind: string; delayMs: number }[] = [];
  attempts.forEach((attempt, index) => {
    if (attempt.error === undefined) return;
    retries.push({
      ...(attempt.status === undefined ? {} : { status: attempt.status }),
      kind: attempt.error,
      delayMs: attempts[index + 1]?.waitedMs ?? 0,
    });
  });
  return retries;
}

/** View-model role of a model span: `reason` for a reasoning span, else its auxiliary role. */
function spanRole(start: ModelSpanStartedEvent | undefined, done: ModelSpanFinishedEvent | undefined): CallModel['role'] {
  if (start !== undefined) return start.kind === 'reasoning' ? 'reason' : start.request.role ?? 'search';
  return done?.kind === 'reasoning' ? 'reason' : 'search';
}

/** View-model call status of a finished span. */
function spanStatus(status: SpanFinishedEvent['status']): CallModel['status'] {
  if (status === 'ok') return 'ok';
  if (status === 'failed') return 'failed';
  return 'aborted';
}

/** View-model action status of a committed action event. */
function toItemStatus(status: ActionStatus): ItemStatus {
  return status === 'interrupted' ? 'aborted' : status;
}

/** View-model action kind of a reasoning action type. */
function toActionKind(type: string | undefined): ActionModel['kind'] {
  switch (type) {
    case 'search':
    case 'dispatch':
    case 'document':
    case 'todo':
    case 'vcs':
    case 'project':
    case 'schedule':
      return type;
    default:
      return 'dispatch';
  }
}

/** True for a system fault or warning; both surface as an error item. */
function isFault(event: LedgerEvent): event is SystemNoticeEvent {
  const type = eventType(event);
  return type === 'system.error' || type === 'system.warning';
}

/** Usage of a finished model span, mapped onto the view-model field names. */
function usageOf(metrics: ModelSpanFinishedEvent['metrics']): CallModel['usage'] | undefined {
  const usage = metrics?.usage;
  if (usage === undefined) return undefined;
  return {
    ...(usage.inputTokens === undefined ? {} : { input: usage.inputTokens }),
    ...(usage.cachedInputTokens === undefined ? {} : { cachedInput: usage.cachedInputTokens }),
    ...(usage.outputTokens === undefined ? {} : { output: usage.outputTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
  };
}

function eventType(event: LedgerEvent): string {
  return (event as { type: string }).type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readKind(value: unknown): SessionFile['kind'] | undefined {
  return value === 'image' || value === 'file' ? value : undefined;
}

/**
 * Projects one ledger session file into the view model, copying only known
 * metadata, bounded text-token fields and prepared-preview metadata, so raw
 * file bytes or an encoded payload can never leak into the UI. There is no
 * ledger id: identity is `path` + `hash`.
 */
export function projectSessionFile(value: unknown): SessionFile | undefined {
  if (!isRecord(value)) return undefined;
  const path = readString(value.path);
  const name = readString(value.name);
  const kind = readKind(value.kind);
  if (path === undefined || name === undefined || kind === undefined) return undefined;
  const width = readNumber(value.width);
  const height = readNumber(value.height);
  const taskRunId = readString(value.taskRunId);
  const actionId = readString(value.actionId);
  const role = readString(value.role);
  const text = readString(value.text);
  const tokens = readNumber(value.tokens);
  const totalTokens = readNumber(value.totalTokens);
  const processedPath = readString(value.processedPath);
  const processedMime = readString(value.processedMime);
  const processedWidth = readNumber(value.processedWidth);
  const processedHeight = readNumber(value.processedHeight);
  const processedBytes = readNumber(value.processedBytes);
  return {
    path,
    name,
    kind,
    mime: readString(value.mime) ?? 'application/octet-stream',
    bytes: readNumber(value.bytes) ?? 0,
    hash: readString(value.hash) ?? '',
    source: value.source === 'task' ? 'task' : 'user',
    description: readString(value.description) ?? name,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(taskRunId === undefined ? {} : { taskRunId }),
    ...(actionId === undefined ? {} : { actionId }),
    ...(role === undefined ? {} : { role }),
    ...(text === undefined ? {} : { text }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(value.truncated === true ? { truncated: true } : {}),
    ...(processedPath === undefined ? {} : { processedPath }),
    ...(processedMime === undefined ? {} : { processedMime }),
    ...(processedWidth === undefined ? {} : { processedWidth }),
    ...(processedHeight === undefined ? {} : { processedHeight }),
    ...(processedBytes === undefined ? {} : { processedBytes }),
  };
}

/** Projects an array of ledger session files, dropping malformed entries. */
export function projectSessionFileList(value: unknown): SessionFile[] {
  if (!Array.isArray(value)) return [];
  return value.map(projectSessionFile).filter((file): file is SessionFile => file !== undefined);
}

/** First nonempty line, for compact summaries. */
function firstLine(text: string): string {
  return text.split('\n', 1)[0]?.trim() ?? '';
}

/** Human-readable rendering of a `document.found` result for the context ledger. */
function formatDocSearch(record: DocumentFoundEvent): string {
  const lines: string[] = [];
  if (record.understanding.trim() !== '') lines.push(record.understanding);
  if (record.picks.length > 0) {
    lines.push('', '入选:');
    for (const pick of record.picks) {
      lines.push(`- ${pick.title}（${pick.path}）${pick.reason !== '' ? ` — ${pick.reason}` : ''}`);
    }
  }
  if (record.near.length > 0) {
    lines.push('', '近似:');
    for (const pick of record.near) lines.push(`- ${pick.title}（${pick.path}）`);
  }
  if (record.notes.length > 0) {
    lines.push('', '备注:');
    for (const note of record.notes) lines.push(`- ${note}`);
  }
  return lines.join('\n');
}

const turnCache = new Map<string, Map<number, { signature: string; model: TurnModel }>>();

/**
 * Pure fold of the ledger, the live-call snapshot and task statuses into the
 * page view model. A turn whose `lastSeq` and relevant live/task inputs are
 * unchanged reuses its previous object so `React.memo` can skip it.
 */
export function fold(
  events: readonly LedgerEvent[],
  live: readonly LiveCall[],
  tasks: Record<string, SessionBridgeTaskBrief>,
  options: FoldOptions = {},
): SessionModel {
  const sessionKey = options.sessionId ?? '';
  const interrupting = new Set(options.interrupting ?? []);

  let snapshot: SessionModel['snapshot'];
  const turnEvents = new Map<number, LedgerEvent[]>();
  for (const event of events) {
    if (eventType(event) === 'session.created') {
      const record = event as unknown as { snapshot?: WorkspaceSnapshot };
      if (record.snapshot) {
        snapshot = {
          takenAt: record.snapshot.takenAt,
          deviceName: record.snapshot.deviceName,
          projects: (record.snapshot.projects ?? []).map((project) => ({
            id: project.id,
            workspaceDir: project.workspaceDir,
            ...(project.displayName === undefined ? {} : { displayName: project.displayName }),
            ...(project.branch === undefined ? {} : { branch: project.branch }),
            ...(project.head === undefined ? {} : { head: project.head }),
          })),
        };
      }
    }
    if (event.turn === undefined) continue;
    const bucket = turnEvents.get(event.turn);
    if (bucket) bucket.push(event);
    else turnEvents.set(event.turn, [event]);
  }

  const perSession = turnCache.get(sessionKey) ?? new Map();
  turnCache.set(sessionKey, perSession);

  const turns: TurnModel[] = [];
  const allCalls: CallModel[] = [];
  for (const turnId of [...turnEvents.keys()].sort((a, b) => a - b)) {
    const model = buildTurn(turnId, turnEvents.get(turnId)!, live, tasks, interrupting.has(turnId), perSession);
    turns.push(model);
    allCalls.push(...model.calls);
  }

  return {
    ...(snapshot === undefined ? {} : { snapshot }),
    turns,
    runningTurns: turns.filter((turn) => turn.status === 'running').length,
    calls: allCalls,
  };
}

function signatureOf(turnId: number, events: LedgerEvent[], live: readonly LiveCall[], tasks: Record<string, SessionBridgeTaskBrief>, interrupting: boolean): string {
  const callIds = new Set<string>();
  for (const event of events) {
    const type = eventType(event);
    if (type === 'span.started' || type === 'span.finished') {
      const id = (event as { id?: string }).id;
      if (id) callIds.add(id);
    }
  }
  const liveSlice = live.filter((entry) => callIds.has(entry.spanId)).map((entry) => [entry.spanId, entry.text.length, entry.reasoning.length]);
  const taskIds = new Set<string>();
  for (const event of events) {
    const taskRunId = (event as { taskRunId?: string }).taskRunId;
    if (taskRunId) taskIds.add(taskRunId);
    // A dispatch's run id now arrives on its task span rather than a second
    // action.started; include it so a later task brief refresh rebuilds the turn.
    if (eventType(event) === 'span.started') {
      const record = event as SpanStartedEvent;
      if (record.kind === 'task') taskIds.add(record.request.taskRunId);
    }
  }
  const taskSlice = [...taskIds].sort().map((id) => [id, tasks[id]?.status ?? '']);
  const lastSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
  return JSON.stringify([lastSeq, liveSlice, taskSlice, interrupting ? 1 : 0]);
}

function lastOfType<T extends LedgerEvent['type']>(events: LedgerEvent[], type: T): Extract<LedgerEvent, { type: T }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (eventType(event) === type) return event as Extract<LedgerEvent, { type: T }>;
  }
  return undefined;
}

function buildTurn(
  turnId: number,
  events: LedgerEvent[],
  live: readonly LiveCall[],
  tasks: Record<string, SessionBridgeTaskBrief>,
  interrupting: boolean,
  cache: Map<number, { signature: string; model: TurnModel }>,
): TurnModel {
  const signature = signatureOf(turnId, events, live, tasks, interrupting);
  const cached = cache.get(turnId);
  if (cached && cached.signature === signature) return cached.model;

  const started = lastOfType(events, 'turn.started') as TurnStartedEvent | undefined;
  const finished = lastOfType(events, 'turn.finished') as TurnFinishedEvent | undefined;
  const interrupted = lastOfType(events, 'turn.interrupted') as TurnInterruptedEvent | undefined;

  const startedAt = started?.at ?? events[0]?.at ?? '';
  const endedAt = finished?.at;
  const status: TurnStatus = finished ? finished.status : 'running';

  const calls = buildCalls(events, live, finished !== undefined);
  const contextItems = buildContextItems(events);
  const actions = buildActions(events, contextItems, tasks, status !== 'running');
  const cycles = buildCycles(events, calls, actions, contextItems);
  const cycle = cycles.length > 0 ? cycles[cycles.length - 1]!.index : 0;
  const attachments = buildUserAttachments(events);

  // Every publication sent to the user projects into `replies` in timeline
  // order, each keeping its kind. `final` is the latest final-kind reply. The
  // last-reply coalescing applies only when a successfully completed turn
  // recorded no final-kind reply; a failed, interrupted or running turn
  // without a final-kind reply keeps `final` undefined, so its fallback, error
  // or interruption display is unchanged. A live reply span is never
  // fabricated into a user-facing message before it commits.
  const replyEvents = events.filter((event): event is ReplySentEvent => eventType(event) === 'reply.sent');
  const replyKindsOf = replyKinds(events, replyEvents, finished);
  const replies = replyEvents.map((event, index) => replyModel(event, replyKindsOf[index]!));
  const committedFinal = replies.filter((reply) => reply.kind === 'final').at(-1)
    ?? (status === 'completed' ? replies.at(-1) : undefined);

  const errors: ErrorItem[] = events
    .filter(isFault)
    .map((event) => ({
      at: event.at,
      stage: event.code,
      message: event.message,
      ...(event.step === undefined ? {} : { cycle: event.step }),
    }));

  const model: TurnModel = {
    id: turnId,
    user: {
      text: started?.text ?? '',
      at: startedAt,
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(started?.sender === undefined ? {} : { sender: started.sender }),
    },
    model: started?.model ?? { provider: '', model: '' },
    status,
    ...(status === 'running' ? { phase: inferPhase(events, calls, actions) } : {}),
    cycle,
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(interrupted === undefined ? {} : { interruptReason: interrupted.reason }),
    interrupting,
    cycles,
    replies,
    ...(committedFinal === undefined ? {} : { final: committedFinal }),
    calls,
    actions,
    errors,
    stats: buildStats(calls, actions, contextItems, events, startedAt, endedAt),
    lastSeq: events.reduce((max, event) => Math.max(max, event.seq), 0),
  };
  cache.set(turnId, { signature, model });
  return model;
}

function replyModel(event: ReplySentEvent, kind: 'progress' | 'final'): ReplyModel {
  return {
    text: event.text,
    at: event.at,
    ...(event.step === undefined ? {} : { cycle: event.step }),
    kind,
  };
}

/**
 * Classify the turn's reply publications, one per input. An explicit durable
 * `kind` always wins. A record written before the field existed is classified
 * from the turn's recorded order: only the closing publication of a completed
 * or failed turn may be the final reply — the turn's last publication, on its
 * last step, with no later step or started action after it. Every other
 * publication, and every publication of an interrupted turn, stays a process
 * update, so a turn with only progress publications has no final reply.
 */
function replyKinds(
  events: LedgerEvent[],
  replies: readonly ReplySentEvent[],
  finished: TurnFinishedEvent | undefined,
): ('progress' | 'final')[] {
  const terminal = finished !== undefined && finished.status !== 'interrupted';
  const last = replies[replies.length - 1];
  const maxStep = events.reduce((max, event) => (event.step !== undefined && event.step > max ? event.step : max), 0);
  return replies.map((reply) => {
    if (reply.kind !== undefined) return reply.kind;
    if (!terminal || reply !== last) return 'progress';
    if (reply.step !== undefined && reply.step < maxStep) return 'progress';
    const continued = events.some((event) => event.seq > reply.seq
      && (eventType(event) === 'step.started' || eventType(event) === 'action.started'));
    return continued ? 'progress' : 'final';
  });
}

/** User attachments for a turn, from its `files.attached` events with source `user`. */
function buildUserAttachments(events: LedgerEvent[]): SessionFile[] {
  const files: SessionFile[] = [];
  for (const event of events) {
    if (eventType(event) !== 'files.attached') continue;
    const record = event as FilesAttachedEvent;
    if (record.source !== 'user') continue;
    files.push(...projectSessionFileList(record.files));
  }
  return files;
}

/** Auxiliary roles whose span holds several model rounds and sums their metrics. */
const MULTI_ROUND_AUX_ROLES: ReadonlySet<CallModel['role']> = new Set<CallModel['role']>([
  'document',
  'todo',
  'vcs',
  'project',
  'schedule',
]);

/** Per-request context snapshots of every span, keyed by span id, in ledger order. */
function snapshotsBySpan(events: LedgerEvent[]): Map<string, CallContextSnapshot[]> {
  const bySpan = new Map<string, CallContextSnapshot[]>();
  for (const event of events) {
    if (eventType(event) !== 'span.context') continue;
    const record = event as SpanContextEvent;
    const snapshot: CallContextSnapshot = {
      seq: record.seq,
      model: record.model,
      ...(record.inputTokens === undefined ? {} : { inputTokens: record.inputTokens }),
    };
    const list = bySpan.get(record.id);
    if (list) list.push(snapshot);
    else bySpan.set(record.id, [snapshot]);
  }
  for (const list of bySpan.values()) list.sort((a, b) => a.seq - b.seq);
  return bySpan;
}

/** True when `value` is a `provider/model` public id, never a bare model name. */
function isPublicModelId(value: string): boolean {
  const separator = value.indexOf('/');
  return separator > 0 && separator < value.length - 1;
}

/**
 * The public id of the last successful attempt's route, when the transport
 * recorded one. A provider-native or bare model name is never treated as a
 * public id.
 */
function lastSuccessfulAttemptModel(attempts: SpanAttempts | undefined): string | undefined {
  let model: string | undefined;
  for (const attempt of attempts ?? []) {
    if (attempt.error !== undefined || attempt.model === undefined) continue;
    if (isPublicModelId(attempt.model)) model = attempt.model;
  }
  return model;
}

/**
 * The context snapshots of one span written before `span.context` existed. The
 * identity is the request's own serving model — never the provider-native
 * `responseModel` — falling back to the last successful attempt's public route
 * and then the started route. A single-request span may reuse its own reported
 * usage as its one snapshot; a legacy multi-round auxiliary span (held
 * project/document/vcs/schedule) must not infer occupancy from its summed usage
 * or a first-round estimate, so it stays unknown. Either way an unknown marker
 * is emitted at the span's sequence so a newer uninstrumented finished span
 * cannot be overridden by an older known sample.
 */
function legacySnapshots(
  role: CallModel['role'],
  done: ModelSpanFinishedEvent,
  start: ModelSpanStartedEvent | undefined,
): CallContextSnapshot[] {
  const model = done.requestModel ?? lastSuccessfulAttemptModel(done.metrics?.attempts) ?? start?.request.model ?? '';
  const reported = MULTI_ROUND_AUX_ROLES.has(role) ? undefined : done.metrics?.usage?.inputTokens;
  const known = model !== '' && reported !== undefined && Number.isFinite(reported) && reported >= 0;
  if (!known) return [{ seq: done.seq, model }];
  return [{ seq: done.seq, model, inputTokens: reported }];
}

function buildCalls(events: LedgerEvent[], live: readonly LiveCall[], turnEnded: boolean): CallModel[] {
  const startedEvents = new Map<string, ModelSpanStartedEvent>();
  const completed = new Map<string, ModelSpanFinishedEvent>();
  for (const event of events) {
    const type = eventType(event);
    if (type === 'span.started') {
      const record = event as SpanStartedEvent;
      if (record.kind === 'task') continue;
      startedEvents.set(record.id, record);
    } else if (type === 'span.finished') {
      const record = event as SpanFinishedEvent;
      if (record.kind === 'task') continue;
      completed.set(record.id, record);
    }
  }
  const snapshots = snapshotsBySpan(events);

  const liveById = new Map(live.map((entry) => [entry.spanId, entry]));
  const ids = [...new Set([...startedEvents.keys(), ...completed.keys()])];
  const calls: CallModel[] = ids.map((id) => {
    const start = startedEvents.get(id);
    const done = completed.get(id);
    const role = spanRole(start, done);
    const recorded = snapshots.get(id);
    if (done) {
      // The transport records every measured fact in `metrics`; a historical
      // span without one stays without usage, ttft or a speed sample.
      const metrics = done.metrics;
      const usage = usageOf(metrics);
      const tps = metrics !== undefined && metrics.streamTokens !== undefined && metrics.streamMs !== undefined
        ? { outputTokens: metrics.streamTokens, windowMs: metrics.streamMs }
        : undefined;
      const startedAt = start?.at ?? done.at;
      const startMs = Date.parse(startedAt);
      const firstTokenAt = metrics?.ttftMs !== undefined && Number.isFinite(startMs)
        ? new Date(startMs + metrics.ttftMs).toISOString()
        : undefined;
      const retries = metrics === undefined ? [] : retriesOf(metrics.attempts);
      const step = done.step ?? start?.step;
      const context = recorded ?? legacySnapshots(role, done, start);
      return {
        id,
        role,
        model: start?.request.model ?? '',
        status: spanStatus(done.status),
        turn: done.turn ?? start?.turn ?? 0,
        ...(step === undefined ? {} : { cycle: step }),
        ...(start?.parent === undefined ? {} : { parent: start.parent }),
        startedAt,
        ...(firstTokenAt === undefined ? {} : { firstTokenAt }),
        endedAt: done.at,
        ...(usage === undefined ? {} : { usage }),
        ...(context.length === 0 ? {} : { snapshots: context }),
        ...(tps === undefined ? {} : { tps }),
        ...(start?.request.inputEstimate === undefined ? {} : { estimatedInputTokens: start.request.inputEstimate }),
        ...(start?.request.layers === undefined ? {} : { layers: start.request.layers }),
        ...(start?.request.effort?.sent === undefined ? {} : { reasoningEffort: start.request.effort.sent }),
        ...(start?.request.effort?.requested === undefined ? {} : { requestedReasoningEffort: start.request.effort.requested }),
        ...(start?.request.route?.candidates === undefined ? {} : { routeCandidates: start.request.route.candidates }),
        ...(start?.request.route?.rank === undefined ? {} : { selectedRank: start.request.route.rank }),
        ...(retries.length === 0 ? {} : { retries }),
        output: done.output ?? '',
        ...(done.reasoning === undefined ? {} : { reasoning: done.reasoning }),
        ...(done.error === undefined ? {} : { error: spanErrorText(done.error) }),
      };
    }
    const request = start!.request;
    const snapshot = liveById.get(id);
    return {
      id,
      role,
      model: request.model,
      status: turnEnded ? 'aborted' : 'running',
      turn: start!.turn ?? 0,
      ...(start!.step === undefined ? {} : { cycle: start!.step }),
      ...(start!.parent === undefined ? {} : { parent: start!.parent }),
      startedAt: start!.at,
      ...(recorded === undefined ? {} : { snapshots: recorded }),
      estimatedInputTokens: request.inputEstimate,
      layers: request.layers,
      ...(request.effort?.sent === undefined ? {} : { reasoningEffort: request.effort.sent }),
      ...(request.effort?.requested === undefined ? {} : { requestedReasoningEffort: request.effort.requested }),
      ...(request.route?.candidates === undefined ? {} : { routeCandidates: request.route.candidates }),
      ...(request.route?.rank === undefined ? {} : { selectedRank: request.route.rank }),
      output: snapshot?.text ?? '',
      ...(snapshot?.reasoning ? { reasoning: snapshot.reasoning } : {}),
    };
  });

  return calls.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function buildContextItems(events: LedgerEvent[]): ContextItem[] {
  const items: ContextItem[] = [];
  for (const event of events) {
    const type = eventType(event);
    if (type === 'memory.recalled') {
      const record = event as MemoryRecalledEvent;
      items.push({
        key: String(event.seq),
        kind: 'memory',
        path: record.path,
        content: record.content,
        source: record.source,
        version: record.version,
        ...(record.parent === undefined ? {} : { actionId: record.parent }),
      });
    } else if (type === 'document.content') {
      const record = event as DocumentContentEvent;
      items.push({
        key: String(event.seq),
        kind: record.source === 'project-instructions' ? 'instructions' : 'doc',
        path: record.path,
        title: record.title,
        content: record.content,
        source: record.source,
        format: record.format,
        version: record.version,
        updated: record.updated,
        ...(record.base === undefined ? {} : { base: record.base }),
        ...(record.parent === undefined ? {} : { actionId: record.parent }),
      });
    } else if (type === 'document.found') {
      const record = event as DocumentFoundEvent;
      items.push({
        key: String(event.seq),
        kind: 'search',
        path: '',
        title: firstLine(record.understanding),
        content: formatDocSearch(record),
        source: 'read',
        actionId: record.parent,
      });
    } else if (type === 'reasoning.thinking') {
      const record = event as ReasoningThinkingEvent;
      items.push({
        key: String(event.seq),
        kind: 'thinking',
        path: '',
        title: record.parent,
        content: record.text,
        source: 'read',
      });
    } else if (type === 'files.attached') {
      const record = event as FilesAttachedEvent;
      if (record.source === 'user') continue;
      const files = projectSessionFileList(record.files);
      items.push({
        key: String(event.seq),
        kind: 'files',
        path: files[0]?.path ?? '',
        title: `${files.length} 个文件`,
        content: files.map((file) => file.name).join('\n'),
        source: 'read',
        ...(record.parent === undefined ? {} : { actionId: record.parent }),
      });
    } else if (type === 'system.info' && (event as SystemNoticeEvent).code === 'memory.saved') {
      // A memory the session wrote to the workspace. It is a write, explicitly
      // not a `memory.recalled` read.
      const record = event as SystemNoticeEvent;
      items.push({
        key: String(event.seq),
        kind: 'memory',
        path: '',
        title: 'Saved memory',
        content: record.message,
        source: 'write',
      });
    } else if (isFault(event)) {
      const record = event;
      items.push({
        key: String(event.seq),
        kind: 'error',
        path: '',
        title: record.code,
        content: record.message,
        source: 'read',
      });
    }
  }
  return items;
}

function buildActions(
  events: LedgerEvent[],
  contextItems: ContextItem[],
  tasks: Record<string, SessionBridgeTaskBrief>,
  turnEnded: boolean,
): ActionModel[] {
  const started = new Map<string, ActionStartedEvent>();
  const finished = new Map<string, ActionFinishedEvent>();
  const titles = new Map<string, string>();
  const taskSpans = new Map<string, { task: string; project?: string; taskRunId: string; at: string }>();
  const writes = new Map<string, {
    path: string;
    change: WorkspaceChangedEvent['change'];
    worktreeId?: string;
  }[]>();
  const filesByAction = new Map<string, SessionFile[]>();
  const filesByTaskRun = new Map<string, SessionFile[]>();

  for (const event of events) {
    const type = eventType(event);
    if (type === 'action.started') {
      const record = event as ActionStartedEvent;
      started.set(record.id, record);
    } else if (type === 'action.finished') {
      const record = event as ActionFinishedEvent;
      finished.set(record.id, record);
    } else if (type === 'action.titled') {
      const record = event as ActionTitledEvent;
      titles.set(record.id, record.title);
    } else if (type === 'span.started') {
      // A dispatch's task span is parented by its action and carries the run id
      // (and task name) as soon as the run opens.
      const record = event as SpanStartedEvent;
      // The task span opens with the run; its `at` is the run's own start.
      if (record.kind === 'task') taskSpans.set(record.parent, { ...record.request, at: record.at });
    } else if (type === 'workspace.changed') {
      const record = event as WorkspaceChangedEvent;
      const bucket = writes.get(record.parent);
      const entry = {
        path: record.target,
        change: record.change,
        ...(record.worktreeId === undefined ? {} : { worktreeId: record.worktreeId }),
      };
      if (bucket) bucket.push(entry);
      else writes.set(record.parent, [entry]);
    } else if (type === 'files.attached') {
      const record = event as FilesAttachedEvent;
      if (record.source !== 'task') continue;
      const files = projectSessionFileList(record.files);
      if (files.length === 0) continue;
      if (record.parent !== undefined) {
        const bucket = filesByAction.get(record.parent);
        if (bucket) bucket.push(...files);
        else filesByAction.set(record.parent, [...files]);
      }
      if (record.taskRunId !== undefined) {
        const bucket = filesByTaskRun.get(record.taskRunId);
        if (bucket) bucket.push(...files);
        else filesByTaskRun.set(record.taskRunId, [...files]);
      }
    }
  }

  const ids = [...new Set([...started.keys(), ...finished.keys()])];
  const actions: ActionModel[] = ids.map((actionId) => {
    const start = started.get(actionId);
    const end = finished.get(actionId);
    const cycle = start?.step ?? end?.step ?? 0;
    const kind = toActionKind(start?.action.type ?? end?.action.type);
    const outputs = contextItems.filter((item) => item.actionId === actionId);
    // The run id is durable on action.finished, on a legacy second
    // action.started, and otherwise on the task span opened when the run began.
    const taskSpan = taskSpans.get(actionId);
    const taskRunId = end?.taskRunId ?? start?.taskRunId ?? taskSpan?.taskRunId;
    // The implementation phase times from the run it opened, not from the
    // dispatch action's own start: the compile call keeps its own duration on
    // its spans, so the turn's implementation elapsed never absorbs it. A
    // legacy record whose run id arrived on a second `action.started` times
    // from that event.
    const runStartedAt = taskSpan?.at ?? (start?.taskRunId === undefined ? undefined : start.at);
    const status: ItemStatus = end === undefined ? (turnEnded ? 'cancelled' : 'running') : toItemStatus(end.status);
    const intent = start === undefined ? '' : firstLine(start.action.prompt);
    const title = titles.get(actionId) ?? actionLabel({ kind, intent });
    const files = filesByAction.get(actionId)
      ?? (taskRunId === undefined ? undefined : filesByTaskRun.get(taskRunId))
      ?? [];
    return {
      id: actionId,
      kind,
      title,
      ...(intent === '' ? {} : { subtitle: intent }),
      status,
      startedAt: runStartedAt ?? start?.at ?? end?.at ?? '',
      ...(end?.at === undefined ? {} : { endedAt: end.at }),
      ...(start?.input === undefined ? {} : { parsed: start.input }),
      ...(end?.result === undefined ? {} : { result: end.result }),
      ...(taskRunId === undefined ? {} : { taskRunId }),
      ...(taskRunId === undefined || tasks[taskRunId] === undefined ? {} : { task: tasks[taskRunId] }),
      ...(files.length === 0 ? {} : { files }),
      outputs,
      writes: writes.get(actionId) ?? [],
      afterInterrupt: end?.afterInterrupt ?? false,
      cycle,
    };
  });

  return actions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function buildCycles(
  events: LedgerEvent[],
  calls: CallModel[],
  actions: ActionModel[],
  contextItems: ContextItem[],
): CycleModel[] {
  const numbers = new Set<number>();
  for (const event of events) if (event.step !== undefined && event.step > 0) numbers.add(event.step);
  for (const call of calls) if (call.cycle !== undefined && call.cycle > 0) numbers.add(call.cycle);
  const indexes = [...numbers].sort((a, b) => a - b);
  if (indexes.length === 0) return [];

  const started = lastOfType(events, 'turn.started') as TurnStartedEvent | undefined;
  const finished = lastOfType(events, 'turn.finished') as TurnFinishedEvent | undefined;
  const turnStart = started?.at ?? events[0]?.at ?? '';

  // Cycle N starts at the previous cycle's last `action.finished`, or turn start.
  const starts = indexes.map((index, position) => {
    if (position === 0) return turnStart;
    const previousIndex = indexes[position - 1]!;
    const finishedAt = events
      .filter((event) => eventType(event) === 'action.finished' && event.step === previousIndex)
      .map((event) => event.at)
      .sort();
    const lastFinished = finishedAt[finishedAt.length - 1];
    if (lastFinished) return lastFinished;
    return actions.filter((action) => action.cycle === index).map((action) => action.startedAt).sort()[0] ?? turnStart;
  });

  const cycles: CycleModel[] = indexes.map((index, position) => {
    const cycleStart = starts[position]!;
    const cycleEnd = position + 1 < indexes.length ? starts[position + 1] : finished?.at;

    const cycleActions = actions.filter((action) => action.cycle === index);
    const cycleEvents = events.filter((event) => event.step === index);
    const reasonCompleted = lastOfType(cycleEvents, 'reasoning.completed') as
      | ReasoningCompletedEvent
      | undefined;
    const reasonCalls = calls.filter((call) => call.role === 'reason' && call.cycle === index);
    const running = reasonCalls.find((call) => call.status === 'running');
    const committed = reasonCalls.find((call) => call.status !== 'running');
    const thinkingEvent = [...cycleEvents]
      .reverse()
      .find((event): event is ReasoningThinkingEvent => eventType(event) === 'reasoning.thinking');
    const thinkingText = thinkingEvent?.text ?? running?.reasoning ?? committed?.reasoning;
    const reasoning = running
      ? { callId: running.id, text: running.output, ...(thinkingText ? { thinking: thinkingText } : {}), streaming: true }
      : committed
        ? {
            callId: committed.id,
            text: committed.output !== '' ? committed.output : reasonCompleted?.text ?? '',
            ...(thinkingText ? { thinking: thinkingText } : {}),
            streaming: false,
          }
        : reasonCompleted
          ? {
              callId: reasonCompleted.parent,
              text: reasonCompleted.text,
              ...(thinkingText ? { thinking: thinkingText } : {}),
              streaming: false,
            }
          : undefined;

    const errors = cycleEvents
      .filter(isFault)
      .map((record) => {
        return { at: record.at, stage: record.code, message: record.message, ...(record.step === undefined ? {} : { cycle: record.step }) };
      });

    return {
      index,
      startedAt: cycleStart,
      ...(cycleEnd === undefined ? {} : { endedAt: cycleEnd }),
      context: contextItems.filter((item) => cycleOfSeq(events, item.key) === index),
      ...(reasoning === undefined ? {} : { reasoning }),
      actionIds: cycleActions.map((action) => action.id),
      errors,
    };
  });

  return cycles;
}

function cycleOfSeq(events: LedgerEvent[], seqKey: string): number {
  const seq = Number(seqKey);
  return events.find((event) => event.seq === seq)?.step ?? 0;
}

/** True for a dispatch action that has opened a task run and is still executing. */
export function isRunningTask(action: ActionModel): boolean {
  return action.kind === 'dispatch' && action.status === 'running' && action.taskRunId !== undefined;
}

function inferPhase(events: LedgerEvent[], calls: CallModel[], actions: ActionModel[]): Phase {
  // Running calls take priority: reason -> reply -> action -> preparing.
  const running = calls.filter((call) => call.status === 'running');
  if (running.some((call) => call.role === 'reason')) return 'reasoning';
  if (running.some((call) => call.role === 'reply')) return 'replying';

  const runningActions = actions.filter((action) => action.status === 'running');
  // A dispatch that has opened its task run and is still executing is the
  // implementation phase: the task run is the work, not the compile call.
  if (runningActions.some(isRunningTask)) return 'acting';
  // A dispatch that has not opened a run yet is still compiling its input: the
  // compile/auxiliary phase, never a running implementation.
  if (runningActions.some((action) => action.kind === 'dispatch')) return 'preparing';
  if (runningActions.length > 0) return 'acting';

  // Fallback used before the live layer provides running calls: infer from
  // events. A task span that opened and has not closed is a running
  // implementation even when no model call observes it.
  let phase: Phase = 'preparing';
  for (const event of events) {
    const type = eventType(event);
    if (type === 'span.started') {
      const record = event as SpanStartedEvent;
      if (record.kind === 'task') phase = 'acting';
      else if (record.kind === 'auxiliary' && (record.request.role === 'search' || record.request.role === 'memory-search')) phase = 'preparing';
    }
    if (type === 'span.finished' && (event as SpanFinishedEvent).kind === 'task') phase = 'preparing';
    if (type === 'document.found' || type === 'memory.recalled') phase = 'reasoning';
    if (type === 'action.started') {
      const record = event as ActionStartedEvent;
      phase = record.action.type === 'dispatch' && record.taskRunId === undefined ? 'preparing' : 'acting';
    }
    if (type === 'reasoning.completed') {
      const hasAction = events.some((other) => other.step === event.step && eventType(other) === 'action.started');
      phase = hasAction ? 'acting' : 'replying';
    }
  }
  return phase;
}

function buildStats(
  calls: CallModel[],
  actions: ActionModel[],
  contextItems: ContextItem[],
  events: LedgerEvent[],
  startedAt: string,
  endedAt: string | undefined,
): TurnStats {
  const reason = calls.filter((call) => call.role === 'reason');
  const cheap = calls.filter((call) => call.role !== 'reason');

  const sumUsage = (subset: CallModel[]): { input?: number; cachedInput?: number; output?: number; reasoning?: number; partial: boolean } => {
    let input: number | undefined;
    let cachedInput: number | undefined;
    let output: number | undefined;
    let reasoning: number | undefined;
    let partial = false;
    for (const call of subset) {
      if (call.usage === undefined) {
        partial = true;
        continue;
      }
      input = (input ?? 0) + (call.usage.input ?? 0);
      if (call.usage.cachedInput !== undefined) cachedInput = (cachedInput ?? 0) + call.usage.cachedInput;
      output = (output ?? 0) + (call.usage.output ?? 0);
      if (call.usage.reasoning !== undefined) reasoning = (reasoning ?? 0) + call.usage.reasoning;
    }
    return {
      ...(input === undefined ? {} : { input }),
      ...(cachedInput === undefined ? {} : { cachedInput }),
      ...(output === undefined ? {} : { output }),
      ...(reasoning === undefined ? {} : { reasoning }),
      partial,
    };
  };

  const expensive = sumUsage(reason);
  const cheapSum = sumUsage(cheap);
  const wallMs = endedAt === undefined ? 0 : Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));

  return {
    wallMs,
    expensive: { calls: reason.length, ...expensive },
    cheap: { calls: cheap.length, ...cheapSum },
    dispatches: actions.filter((action) => action.kind === 'dispatch').length,
    docsLoaded: contextItems.length,
    docsWritten: events.filter((event) => {
      if (eventType(event) !== 'workspace.changed') return false;
      const record = event as WorkspaceChangedEvent;
      return record.scope === 'document' && (record.change === 'created' || record.change === 'updated' || record.change === 'deleted');
    }).length,
  };
}
