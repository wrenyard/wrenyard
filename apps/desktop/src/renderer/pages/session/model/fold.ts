import type {
  DocContentEvent,
  DocSearchEvent,
  ErrorEvent,
  FilesEvent,
  LedgerEvent,
  MemoryRecalledEvent,
  ReplyEvent,
  ThinkingEvent,
  TurnFinishedEvent,
  TurnInterruptedEvent,
  TurnStartedEvent,
  WorkspaceSnapshot,
  WsUpdatedEvent,
} from '@wrenyard/session';
import { actionLabel, CALL_ROLE_LABEL, shortName } from './describe.js';
import type {
  ActionModel,
  ActionNode,
  CallModel,
  ContextItem,
  CycleModel,
  CycleNode,
  ErrorItem,
  ItemStatus,
  LiveCall,
  Phase,
  ReasonNode,
  ReplyModel,
  SessionBridgeTaskBrief,
  SessionFile,
  SessionModel,
  TreeEntry,
  TurnModel,
  TurnNode,
  TurnStats,
  TurnStatus,
} from './types.js';

export interface FoldOptions {
  sessionId?: string;
  /** Turn ids whose interrupt has been requested but not yet acknowledged. */
  interrupting?: readonly number[];
}

type CallEvent = Extract<LedgerEvent, { type: 'call' }>;

/** Structural view of the P3 `call.started` event, kept independent of the union. */
interface CallStartedLike {
  seq: number;
  at: string;
  callId: string;
  role: CallModel['role'];
  model: string;
  turn?: number;
  cycle?: number;
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

/** Human-readable rendering of a `doc.search` result for the context ledger. */
function formatDocSearch(record: DocSearchEvent): string {
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
    if (type === 'call' || type === 'call.started') {
      const callId = (event as { callId?: string }).callId;
      if (callId) callIds.add(callId);
    }
  }
  const liveSlice = live.filter((entry) => callIds.has(entry.callId)).map((entry) => [entry.callId, entry.text.length, entry.reasoning.length]);
  const taskIds = new Set<string>();
  for (const event of events) {
    const taskRunId = (event as { taskRunId?: string }).taskRunId;
    if (taskRunId) taskIds.add(taskRunId);
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

  // Every committed reply event projects into `replies` in timeline order.
  // `final` is the latest committed reply; a live reply call is never
  // fabricated into a user-facing message before it commits.
  const replies = events
    .filter((event): event is ReplyEvent => eventType(event) === 'reply')
    .map(replyModel);
  const committedFinal = replies.at(-1);

  const errors: ErrorItem[] = events
    .filter((event): event is ErrorEvent => eventType(event) === 'error')
    .map((event) => ({
      at: event.at,
      stage: event.stage,
      message: event.message,
      ...(event.cycle === undefined ? {} : { cycle: event.cycle }),
    }));

  const model: TurnModel = {
    id: turnId,
    user: { text: started?.text ?? '', at: startedAt, ...(attachments.length === 0 ? {} : { attachments }) },
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

function replyModel(event: ReplyEvent): ReplyModel {
  return {
    text: event.text,
    at: event.at,
    ...(event.cycle === undefined ? {} : { cycle: event.cycle }),
  };
}

/** User attachments for a turn, from its `files` events with source `user`. */
function buildUserAttachments(events: LedgerEvent[]): SessionFile[] {
  const files: SessionFile[] = [];
  for (const event of events) {
    if (eventType(event) !== 'files') continue;
    const record = event as FilesEvent;
    if (record.source !== 'user') continue;
    files.push(...projectSessionFileList(record.files));
  }
  return files;
}

function buildCalls(events: LedgerEvent[], live: readonly LiveCall[], turnEnded: boolean): CallModel[] {
  const startedEvents = new Map<string, CallStartedLike>();
  const completed = new Map<string, CallEvent>();
  for (const event of events) {
    const type = eventType(event);
    if (type === 'call.started') {
      const record = event as unknown as CallStartedLike;
      startedEvents.set(record.callId, record);
    } else if (type === 'call') {
      const record = event as CallEvent;
      completed.set(record.callId, record);
    }
  }

  const liveById = new Map(live.map((entry) => [entry.callId, entry]));
  const ids = [...new Set([...startedEvents.keys(), ...completed.keys()])];
  const calls: CallModel[] = ids.map((id) => {
    const done = completed.get(id);
    if (done) {
      return {
        id,
        role: done.role,
        model: done.model,
        status: done.status,
        turn: done.turn ?? 0,
        ...(done.cycle === undefined ? {} : { cycle: done.cycle }),
        startedAt: done.startedAt,
        ...(typeof (done as { firstTokenAt?: unknown }).firstTokenAt === 'string'
          ? { firstTokenAt: (done as { firstTokenAt: string }).firstTokenAt }
          : {}),
        endedAt: done.endedAt,
        ...(done.usage === undefined ? {} : { usage: done.usage }),
        estimatedInputTokens: done.estimatedInputTokens,
        layers: done.layers,
        output: done.output,
        ...(done.reasoning === undefined ? {} : { reasoning: done.reasoning }),
        ...(done.error === undefined ? {} : { error: done.error }),
      };
    }
    const startedEvent = startedEvents.get(id)!;
    const snapshot = liveById.get(id);
    return {
      id,
      role: startedEvent.role,
      model: startedEvent.model,
      status: turnEnded ? 'aborted' : 'running',
      turn: startedEvent.turn ?? 0,
      ...(startedEvent.cycle === undefined ? {} : { cycle: startedEvent.cycle }),
      startedAt: startedEvent.at,
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
        ...(record.actionId === undefined ? {} : { actionId: record.actionId }),
      });
    } else if (type === 'doc.content') {
      const record = event as DocContentEvent;
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
        ...(record.actionId === undefined ? {} : { actionId: record.actionId }),
      });
    } else if (type === 'doc.search') {
      const record = event as DocSearchEvent;
      items.push({
        key: String(event.seq),
        kind: 'search',
        path: '',
        title: firstLine(record.understanding),
        content: formatDocSearch(record),
        source: 'read',
        actionId: record.actionId,
      });
    } else if (type === 'thinking') {
      const record = event as ThinkingEvent;
      items.push({
        key: String(event.seq),
        kind: 'thinking',
        path: '',
        title: record.callId,
        content: record.text,
        source: 'read',
      });
    } else if (type === 'files') {
      const record = event as FilesEvent;
      if (record.source === 'user') continue;
      const files = projectSessionFileList(record.files);
      items.push({
        key: String(event.seq),
        kind: 'files',
        path: files[0]?.path ?? '',
        title: `${files.length} 个文件`,
        content: files.map((file) => file.name).join('\n'),
        source: 'read',
        ...(record.actionId === undefined ? {} : { actionId: record.actionId }),
      });
    } else if (type === 'error') {
      const record = event as ErrorEvent;
      items.push({
        key: String(event.seq),
        kind: 'error',
        path: '',
        title: record.stage,
        content: record.message,
        source: 'read',
      });
    }
  }
  return items;
}

/** Structural view of an `action.titled` event, kept independent of the union. */
interface ActionTitledLike {
  seq: number;
  at: string;
  actionId: string;
  title: string;
  turn?: number;
  cycle?: number;
}

/** Nonempty first line of an action's parsed intent payload, when present. */
function parsedIntent(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined;
  const intent = parsed.intent;
  return typeof intent === 'string' && intent.trim() !== '' ? firstLine(intent) : undefined;
}

function buildActions(
  events: LedgerEvent[],
  contextItems: ContextItem[],
  tasks: Record<string, SessionBridgeTaskBrief>,
  turnEnded: boolean,
): ActionModel[] {
  const started = new Map<string, Extract<LedgerEvent, { type: 'action.started' }>>();
  const finished = new Map<string, Extract<LedgerEvent, { type: 'action.finished' }>>();
  const titles = new Map<string, string>();
  const writes = new Map<string, {
    path: string;
    change: WsUpdatedEvent['change'];
    worktreeId?: string;
  }[]>();
  const filesByAction = new Map<string, SessionFile[]>();
  const filesByTaskRun = new Map<string, SessionFile[]>();

  for (const event of events) {
    const type = eventType(event);
    if (type === 'action.started') {
      const record = event as Extract<LedgerEvent, { type: 'action.started' }>;
      started.set(record.actionId, record);
    } else if (type === 'action.finished') {
      const record = event as Extract<LedgerEvent, { type: 'action.finished' }>;
      finished.set(record.actionId, record);
    } else if (type === 'action.titled') {
      const record = event as unknown as ActionTitledLike;
      titles.set(record.actionId, record.title);
    } else if (type === 'ws.updated') {
      const record = event as Extract<LedgerEvent, { type: 'ws.updated' }>;
      const bucket = writes.get(record.actionId);
      const entry = {
        path: record.target,
        change: record.change,
        ...(record.worktreeId === undefined ? {} : { worktreeId: record.worktreeId }),
      };
      if (bucket) bucket.push(entry);
      else writes.set(record.actionId, [entry]);
    } else if (type === 'files') {
      const record = event as FilesEvent;
      if (record.source !== 'task') continue;
      const files = projectSessionFileList(record.files);
      if (files.length === 0) continue;
      if (record.actionId !== undefined) {
        const bucket = filesByAction.get(record.actionId);
        if (bucket) bucket.push(...files);
        else filesByAction.set(record.actionId, [...files]);
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
    const cycle = start?.cycle ?? end?.cycle ?? 0;
    const kind = start?.kind ?? end?.kind ?? 'dispatch';
    const outputs = contextItems.filter((item) => item.actionId === actionId);
    const taskRunId = end?.taskRunId ?? start?.taskRunId;
    const status: ItemStatus = end?.status ?? (turnEnded ? 'cancelled' : 'running');
    const intent = parsedIntent(start?.parsed) ?? '';
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
      startedAt: start?.at ?? end?.at ?? '',
      ...(end?.at === undefined ? {} : { endedAt: end.at }),
      ...(start?.parsed === undefined ? {} : { parsed: start.parsed }),
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
  for (const event of events) if (event.cycle !== undefined && event.cycle > 0) numbers.add(event.cycle);
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
      .filter((event) => eventType(event) === 'action.finished' && event.cycle === previousIndex)
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
    const cycleEvents = events.filter((event) => event.cycle === index);
    const reasonCompleted = lastOfType(cycleEvents, 'reason.completed') as
      | Extract<LedgerEvent, { type: 'reason.completed' }>
      | undefined;
    const reasonCalls = calls.filter((call) => call.role === 'reason' && call.cycle === index);
    const running = reasonCalls.find((call) => call.status === 'running');
    const committed = reasonCalls.find((call) => call.status !== 'running');
    const thinkingEvent = [...cycleEvents]
      .reverse()
      .find((event): event is ThinkingEvent => eventType(event) === 'thinking');
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
              callId: reasonCompleted.callId,
              text: reasonCompleted.text,
              ...(thinkingText ? { thinking: thinkingText } : {}),
              streaming: false,
            }
          : undefined;

    const errors = cycleEvents
      .filter((event) => eventType(event) === 'error')
      .map((event) => {
        const record = event as ErrorEvent;
        return { at: record.at, stage: record.stage, message: record.message, ...(record.cycle === undefined ? {} : { cycle: record.cycle }) };
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
  return events.find((event) => event.seq === seq)?.cycle ?? 0;
}

function inferPhase(events: LedgerEvent[], calls: CallModel[], actions: ActionModel[]): Phase {
  // Running calls take priority: reason -> reply -> action -> preparing.
  const running = calls.filter((call) => call.status === 'running');
  if (running.some((call) => call.role === 'reason')) return 'reasoning';
  if (running.some((call) => call.role === 'reply')) return 'replying';
  if (actions.some((action) => action.status === 'running')) return 'acting';

  // Fallback used before the live layer provides running calls: infer from events.
  let phase: Phase = 'preparing';
  for (const event of events) {
    const type = eventType(event);
    const role = type === 'call' ? (event as CallEvent).role : undefined;
    if (role === 'search' || role === 'memory-search') phase = 'preparing';
    if (type === 'doc.search' || type === 'memory.recalled') phase = 'reasoning';
    if (type === 'action.started') phase = 'acting';
    if (type === 'reason.completed') {
      const hasAction = events.some((other) => other.cycle === event.cycle && eventType(other) === 'action.started');
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
      if (eventType(event) !== 'ws.updated') return false;
      const record = event as Extract<LedgerEvent, { type: 'ws.updated' }>;
      return record.scope === 'document' && (record.change === 'created' || record.change === 'updated');
    }).length,
  };
}

// ─── Session tree projection ───────────────────────────────────────────────

/** A `call.started`/`call` pair merged into one entry. */
interface IndexedCall {
  callId: string;
  role: string;
  model: string;
  /** Start time. */
  at: string;
  turn?: number;
  cycle?: number;
  /** Set when the call event carries an action id. */
  actionId?: string;
  startedAt?: string;
  endedAt?: string;
  /** Terminal status; absent while the call is still running. */
  status?: string;
  usage?: { input?: number; cachedInput?: number; output?: number; reasoning?: number };
  estimatedInputTokens?: number;
  output?: string;
  reasoning?: string;
}

/** Structural view of `action.started`, kept independent of the union. */
interface ActionStartedLike {
  seq: number;
  at: string;
  actionId: string;
  kind: string;
  parsed?: unknown;
  turn?: number;
  cycle?: number;
  taskRunId?: string;
  taskName?: string;
  taskDisplayName?: string;
  project?: string;
}

/** Structural view of `action.finished`, kept independent of the union. */
interface ActionFinishedLike {
  seq: number;
  at: string;
  actionId: string;
  kind?: string;
  status: string;
  result?: string;
  taskRunId?: string;
  turn?: number;
  cycle?: number;
  afterInterrupt?: boolean;
}

function treeRoleLabel(role: string): string {
  return (CALL_ROLE_LABEL as Record<string, string>)[role] ?? role;
}

function indexCalls(events: readonly LedgerEvent[]): Map<string, IndexedCall> {
  const calls = new Map<string, IndexedCall>();
  for (const event of events) {
    const type = eventType(event);
    if (type === 'call.started') {
      const record = event as unknown as {
        callId: string; role: string; model: string; at: string;
        turn?: number; cycle?: number; actionId?: string;
      };
      calls.set(record.callId, {
        callId: record.callId,
        role: record.role,
        model: record.model,
        at: record.at,
        ...(record.turn === undefined ? {} : { turn: record.turn }),
        ...(record.cycle === undefined ? {} : { cycle: record.cycle }),
        ...(record.actionId === undefined ? {} : { actionId: record.actionId }),
      });
    } else if (type === 'call') {
      const record = event as unknown as {
        callId: string; role: string; model: string; at: string;
        status: string; startedAt?: string; endedAt?: string;
        turn?: number; cycle?: number; actionId?: string;
        usage?: { input?: number; cachedInput?: number; output?: number; reasoning?: number };
        estimatedInputTokens?: number; output?: string; reasoning?: string;
      };
      const base = calls.get(record.callId) ?? {
        callId: record.callId,
        role: record.role,
        model: record.model,
        at: record.at,
        ...(record.turn === undefined ? {} : { turn: record.turn }),
        ...(record.cycle === undefined ? {} : { cycle: record.cycle }),
      };
      calls.set(record.callId, {
        ...base,
        role: record.role,
        model: record.model,
        status: record.status,
        ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
        ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
        ...(record.turn === undefined ? {} : { turn: record.turn }),
        ...(record.cycle === undefined ? {} : { cycle: record.cycle }),
        ...(record.actionId === undefined ? {} : { actionId: record.actionId }),
        ...(record.usage === undefined ? {} : { usage: record.usage }),
        ...(record.estimatedInputTokens === undefined ? {} : { estimatedInputTokens: record.estimatedInputTokens }),
        ...(record.output === undefined ? {} : { output: record.output }),
        ...(record.reasoning === undefined ? {} : { reasoning: record.reasoning }),
      });
    }
  }
  return calls;
}

function callMatchesAction(call: IndexedCall, actionId: string): boolean {
  if (call.actionId !== undefined) return call.actionId === actionId;
  return call.callId.startsWith(actionId);
}

function callTreeEntry(call: IndexedCall): TreeEntry {
  const durationMs = call.startedAt !== undefined && call.endedAt !== undefined
    ? Math.max(0, Date.parse(call.endedAt) - Date.parse(call.startedAt))
    : undefined;
  const inputTokens = call.usage?.input ?? call.estimatedInputTokens;
  return {
    at: call.endedAt ?? call.at,
    kind: 'call',
    label: treeRoleLabel(call.role),
    ...(call.model === '' ? {} : { model: call.model }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(call.usage?.output === undefined ? {} : { outputTokens: call.usage.output }),
    ...(durationMs === undefined ? {} : { durationMs }),
    callId: call.callId,
    ...(call.output === undefined || call.output === '' ? {} : { body: call.output }),
  };
}

function docTreeEntry(event: DocContentEvent): TreeEntry {
  const tokens = readNumber((event as unknown as { tokens?: unknown }).tokens);
  return {
    at: event.at,
    kind: 'doc',
    label: shortName(event.path),
    path: event.path,
    ...(tokens === undefined ? {} : { tokens }),
    ...(event.content === '' ? {} : { body: event.content }),
  };
}

function memoryTreeEntry(event: MemoryRecalledEvent): TreeEntry {
  return {
    at: event.at,
    kind: 'memory',
    label: shortName(event.path),
    path: event.path,
    ...(event.content === '' ? {} : { body: event.content }),
  };
}

function collectActionFiles(events: readonly LedgerEvent[], actionId: string, taskRunId: string | undefined): SessionFile[] {
  const files: SessionFile[] = [];
  for (const event of events) {
    if (eventType(event) !== 'files') continue;
    const record = event as FilesEvent;
    if (record.source !== 'task') continue;
    const recordActionId = (record as unknown as { actionId?: string }).actionId;
    const recordTaskRunId = (record as unknown as { taskRunId?: string }).taskRunId;
    const matches = recordActionId === actionId || (taskRunId !== undefined && recordTaskRunId === taskRunId);
    if (!matches) continue;
    files.push(...projectSessionFileList(record.files));
  }
  return files;
}

function buildActionNode(
  actionId: string,
  turnEvents: readonly LedgerEvent[],
  calls: Map<string, IndexedCall>,
  turnRunning: boolean,
): ActionNode {
  const start = turnEvents.find((event) => eventType(event) === 'action.started' && (event as { actionId?: string }).actionId === actionId) as unknown as ActionStartedLike | undefined;
  const end = turnEvents.find((event) => eventType(event) === 'action.finished' && (event as { actionId?: string }).actionId === actionId) as unknown as ActionFinishedLike | undefined;
  const titled = turnEvents.find((event) => eventType(event) === 'action.titled' && (event as { actionId?: string }).actionId === actionId) as unknown as ActionTitledLike | undefined;

  const intent = parsedIntent(start?.parsed) ?? '';
  const kind = (start?.kind ?? end?.kind ?? 'search') as ActionNode['kind'];
  const taskRunId = end?.taskRunId ?? start?.taskRunId;

  const entries: TreeEntry[] = [];
  let compile: TreeEntry | undefined;
  for (const call of calls.values()) {
    if (!callMatchesAction(call, actionId)) continue;
    if (call.role === 'dispatch') {
      if (compile === undefined) compile = callTreeEntry(call);
    } else if (call.role === 'search') {
      entries.push(callTreeEntry(call));
    }
  }
  for (const event of turnEvents) {
    if ((event as { actionId?: string }).actionId !== actionId) continue;
    const type = eventType(event);
    if (type === 'doc.content') entries.push(docTreeEntry(event as DocContentEvent));
    else if (type === 'memory.recalled') entries.push(memoryTreeEntry(event as MemoryRecalledEvent));
  }
  entries.sort((a, b) => a.at.localeCompare(b.at));

  const errors: string[] = [];
  for (const event of turnEvents) {
    if (eventType(event) !== 'error') continue;
    const record = event as ErrorEvent;
    if ((record as unknown as { actionId?: string }).actionId !== actionId) continue;
    errors.push(record.message);
  }

  const status: ActionNode['status'] = (end?.status as ActionNode['status'] | undefined)
    ?? (turnRunning ? 'running' : 'cancelled');

  return {
    id: actionId,
    kind,
    ...(titled === undefined ? {} : { title: titled.title }),
    intent,
    ...(start?.taskName === undefined ? {} : { task: start.taskName }),
    ...(start?.taskDisplayName === undefined ? {} : { taskDisplayName: start.taskDisplayName }),
    ...(start?.project === undefined ? {} : { project: start.project }),
    ...(taskRunId === undefined ? {} : { taskRunId }),
    status,
    startedAt: start?.at ?? end?.at ?? '',
    ...(end?.at === undefined ? {} : { endedAt: end.at }),
    ...(end?.result === undefined || end.result === '' ? {} : { result: end.result }),
    ...(compile === undefined ? {} : { compile }),
    entries,
    files: collectActionFiles(turnEvents, actionId, taskRunId),
    errors,
  };
}

function buildCycleNode(
  index: number,
  turnEvents: readonly LedgerEvent[],
  calls: Map<string, IndexedCall>,
  turnRunning: boolean,
  isLastCycle: boolean,
): CycleNode {
  const cycleEvents = turnEvents.filter((event) => event.cycle === index);

  const times = cycleEvents.map((event) => event.at).filter((at) => at !== '').sort();
  const startedAt = times[0];
  const endedAt = turnRunning && isLastCycle ? undefined : times[times.length - 1];

  const reasonCalls = [...calls.values()].filter((call) => call.role === 'reason' && call.cycle === index);
  const reasonCall = reasonCalls.find((call) => call.status !== undefined) ?? reasonCalls[0];
  const reasonCompleted = lastOfType(cycleEvents, 'reason.completed') as
    | Extract<LedgerEvent, { type: 'reason.completed' }>
    | undefined;
  const thinkingEvent = [...cycleEvents]
    .reverse()
    .find((event): event is ThinkingEvent => eventType(event) === 'thinking');
  const thinking = thinkingEvent?.text !== undefined && thinkingEvent.text !== ''
    ? thinkingEvent.text
    : reasonCall?.reasoning;

  const reason: ReasonNode | undefined = reasonCall !== undefined
    ? {
        callId: reasonCall.callId,
        model: reasonCall.model,
        ...(thinking === undefined || thinking === '' ? {} : { thinking }),
        text: reasonCall.output !== undefined && reasonCall.output !== '' ? reasonCall.output : reasonCompleted?.text ?? '',
        startedAt: reasonCall.startedAt ?? reasonCall.at,
        ...(reasonCall.endedAt === undefined ? {} : { endedAt: reasonCall.endedAt }),
        ...(reasonCall.usage?.input === undefined ? {} : { inputTokens: reasonCall.usage.input }),
        ...(reasonCall.usage?.output === undefined ? {} : { outputTokens: reasonCall.usage.output }),
        ...(reasonCall.usage?.cachedInput === undefined ? {} : { cachedInputTokens: reasonCall.usage.cachedInput }),
      }
    : reasonCompleted !== undefined
      ? {
          callId: reasonCompleted.callId,
          model: '',
          text: reasonCompleted.text,
          startedAt: reasonCompleted.at,
        }
      : undefined;

  const reasonStart = reasonCall?.startedAt ?? reasonCall?.at;

  // Prepare: memory-search calls and memory.recalled events before the reason call.
  const prepare: TreeEntry[] = [];
  for (const call of calls.values()) {
    if (call.role !== 'memory-search' || call.cycle !== index) continue;
    if (reasonStart !== undefined && call.at > reasonStart) continue;
    prepare.push(callTreeEntry(call));
  }
  for (const event of cycleEvents) {
    if (eventType(event) !== 'memory.recalled') continue;
    if (reasonStart !== undefined && event.at > reasonStart) continue;
    prepare.push(memoryTreeEntry(event as MemoryRecalledEvent));
  }
  prepare.sort((a, b) => a.at.localeCompare(b.at));

  const actionIds = new Set<string>();
  for (const event of cycleEvents) {
    const type = eventType(event);
    if (type === 'action.started' || type === 'action.finished') {
      actionIds.add((event as unknown as { actionId: string }).actionId);
    }
  }
  const actions = [...actionIds]
    .map((actionId) => buildActionNode(actionId, turnEvents, calls, turnRunning))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const replies = cycleEvents
    .filter((event): event is ReplyEvent => eventType(event) === 'reply')
    .map((event) => ({ at: event.at, text: event.text }));

  // Errors without an action id belong to the cycle.
  const errors: string[] = [];
  for (const event of cycleEvents) {
    if (eventType(event) !== 'error') continue;
    const record = event as ErrorEvent;
    if ((record as unknown as { actionId?: string }).actionId !== undefined) continue;
    errors.push(record.message);
  }

  const running = turnRunning && isLastCycle && reasonCompleted === undefined && reasonCall !== undefined && reasonCall.status === undefined;

  return {
    cycle: index,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    running,
    prepare,
    ...(reason === undefined ? {} : { reason }),
    actions,
    replies,
    errors,
  };
}

/**
 * Projects the raw ledger into the session tree: turns sorted by start time,
 * each with its cycles, prepare entries, reason call, actions and replies.
 * Actions gather the calls, documents, memories, files, title and errors that
 * carry their action id; errors without one attach to the cycle.
 */
export function buildSessionTree(events: readonly LedgerEvent[]): TurnNode[] {
  const byTurn = new Map<number, LedgerEvent[]>();
  for (const event of events) {
    if (typeof event.turn !== 'number') continue;
    const bucket = byTurn.get(event.turn);
    if (bucket) bucket.push(event);
    else byTurn.set(event.turn, [event]);
  }

  const turns: TurnNode[] = [];
  for (const turn of [...byTurn.keys()].sort((a, b) => a - b)) {
    const turnEvents = byTurn.get(turn)!;
    const started = lastOfType(turnEvents, 'turn.started') as TurnStartedEvent | undefined;
    const finished = lastOfType(turnEvents, 'turn.finished') as TurnFinishedEvent | undefined;
    const interrupted = lastOfType(turnEvents, 'turn.interrupted') as TurnInterruptedEvent | undefined;
    const status: TurnNode['status'] = finished !== undefined
      ? (finished.status as TurnNode['status'])
      : interrupted !== undefined ? 'interrupted' : 'running';
    const startedAt = started?.at ?? turnEvents[0]?.at ?? '';
    const endedAt = finished?.at ?? interrupted?.at;

    const calls = indexCalls(turnEvents);

    const numbers = new Set<number>();
    for (const event of turnEvents) {
      if (typeof event.cycle === 'number' && event.cycle > 0) numbers.add(event.cycle);
    }
    const indexes = [...numbers].sort((a, b) => a - b);
    const cycles: CycleNode[] = indexes.map((cycle, position) =>
      buildCycleNode(cycle, turnEvents, calls, status === 'running', position === indexes.length - 1));

    turns.push({
      turn,
      userText: started?.text ?? '',
      status,
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt }),
      cycles,
    });
  }

  turns.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return turns;
}
