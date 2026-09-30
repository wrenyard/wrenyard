import type {
  ContextSelectedEvent,
  DocReadEvent,
  ErrorEvent,
  LedgerEvent,
  MemoryRecalledEvent,
  ReplyEvent,
  TurnFinishedEvent,
  TurnInterruptedEvent,
  TurnStartedEvent,
  WorkspaceSnapshot,
} from '@wrenyard/session-v2';
import { describeAction } from './describe.js';
import type {
  ActionModel,
  BlockModel,
  CallModel,
  ContextItem,
  CycleModel,
  ErrorItem,
  ItemStatus,
  Phase,
  ReplyModel,
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

type CallEvent = Extract<LedgerEvent, { type: 'call' }>;

function eventType(event: LedgerEvent): string {
  return (event as { type: string }).type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const turnCache = new Map<string, Map<number, { signature: string; model: TurnModel }>>();

/**
 * Pure fold of the ledger into the page view model. A turn whose `lastSeq` and
 * interrupting state are unchanged reuses its previous object so `React.memo`
 * can skip it.
 */
export function fold(
  events: readonly LedgerEvent[],
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
          projects: record.snapshot.projects.map((project) => ({
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
    const model = buildTurn(turnId, turnEvents.get(turnId)!, interrupting.has(turnId), perSession);
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

function signatureOf(turnId: number, events: LedgerEvent[], interrupting: boolean): string {
  const lastSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
  return JSON.stringify([lastSeq, interrupting ? 1 : 0]);
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
  interrupting: boolean,
  cache: Map<number, { signature: string; model: TurnModel }>,
): TurnModel {
  const signature = signatureOf(turnId, events, interrupting);
  const cached = cache.get(turnId);
  if (cached && cached.signature === signature) return cached.model;

  const started = lastOfType(events, 'turn.started') as TurnStartedEvent | undefined;
  const finished = lastOfType(events, 'turn.finished') as TurnFinishedEvent | undefined;
  const interrupted = lastOfType(events, 'turn.interrupted') as TurnInterruptedEvent | undefined;

  const startedAt = started?.at ?? events[0]?.at ?? '';
  const endedAt = finished?.at;
  const status: TurnStatus = finished ? finished.status : 'running';

  const calls = buildCalls(events, finished !== undefined);
  const contextItems = buildContextItems(events);
  const actions = buildActions(events, contextItems, status !== 'running');
  const cycles = buildCycles(events, calls, actions, contextItems);
  const cycle = cycles.length > 0 ? cycles[cycles.length - 1]!.index : 0;

  const progressReplies = events
    .filter((event): event is ReplyEvent => eventType(event) === 'reply' && (event as ReplyEvent).phase === 'progress')
    .map((event) => replyModel(event));
  const finalEvent = lastOfType(events, 'reply') as ReplyEvent | undefined;
  const committedFinal = finalEvent && finalEvent.phase === 'final' ? replyModel(finalEvent) : undefined;

  const runningReplyCalls = calls.filter((call) => call.role === 'reply' && call.status === 'running');
  let streamingFinal: ReplyModel | undefined;
  for (const call of runningReplyCalls) {
    const hasActions = actions.some((action) => action.cycle === call.cycle);
    if (!hasActions && !committedFinal && !streamingFinal) {
      streamingFinal = { phase: 'final', text: call.output, at: call.startedAt, streaming: true, ...(call.cycle === undefined ? {} : { cycle: call.cycle }) };
    } else {
      progressReplies.push({ phase: 'progress', text: call.output, at: call.startedAt, streaming: true, ...(call.cycle === undefined ? {} : { cycle: call.cycle }) });
    }
  }
  progressReplies.sort((a, b) => a.at.localeCompare(b.at));

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
    user: { text: started?.text ?? '', at: startedAt },
    model: started?.model ?? { provider: '', model: '' },
    status,
    ...(status === 'running' ? { phase: inferPhase(events, calls, actions) } : {}),
    cycle,
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(interrupted === undefined ? {} : { interruptReason: interrupted.reason }),
    interrupting,
    cycles,
    progress: progressReplies,
    ...(committedFinal === undefined && streamingFinal === undefined ? {} : { final: committedFinal ?? streamingFinal }),
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
    phase: event.phase,
    text: event.text,
    at: event.at,
    streaming: false,
    ...(event.cycle === undefined ? {} : { cycle: event.cycle }),
  };
}

function buildCalls(events: LedgerEvent[], turnEnded: boolean): CallModel[] {
  const completed = new Map<string, CallEvent>();
  for (const event of events) {
    if (eventType(event) === 'call') {
      const record = event as CallEvent;
      completed.set(record.callId, record);
    }
  }

  const calls: CallModel[] = [...completed.values()].map((done) => ({
    id: done.callId,
    role: done.role,
    model: done.model,
    status: done.status,
    turn: done.turn ?? 0,
    ...(done.cycle === undefined ? {} : { cycle: done.cycle }),
    startedAt: done.startedAt,
    endedAt: done.endedAt,
    ...(done.usage === undefined ? {} : { usage: done.usage }),
    estimatedInputTokens: done.estimatedInputTokens,
    layers: done.layers,
    output: done.output,
    ...(done.reasoning === undefined ? {} : { reasoning: done.reasoning }),
    ...(done.error === undefined ? {} : { error: done.error }),
  }));

  return calls.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function buildContextItems(events: LedgerEvent[]): ContextItem[] {
  const reasons = new Map<string, string>();
  for (const event of events) {
    if (eventType(event) !== 'context.selected') continue;
    for (const selection of (event as ContextSelectedEvent).selections) reasons.set(selection.path, selection.reason);
  }

  const items: ContextItem[] = [];
  for (const event of events) {
    const type = eventType(event);
    if (type === 'memory.recalled') {
      const record = event as MemoryRecalledEvent;
      items.push(contextItem(event, 'memory', record.path, record.content, record.source, record.actionId, undefined, reasons));
    } else if (type === 'doc.read') {
      const record = event as DocReadEvent;
      const kind = record.source === 'project-instructions' ? 'instructions' : 'doc';
      items.push(contextItem(event, kind, record.path, record.content, record.source, record.actionId, record.title, reasons));
    }
  }
  return items;
}

function contextItem(
  event: LedgerEvent,
  kind: ContextItem['kind'],
  path: string,
  content: string,
  source: ContextItem['source'],
  actionId: string | undefined,
  title: string | undefined,
  reasons: Map<string, string>,
): ContextItem {
  const reason = reasons.get(path);
  return {
    key: String(event.seq),
    kind,
    path,
    source,
    content,
    ...(title === undefined ? {} : { title }),
    ...(reason === undefined ? {} : { reason }),
    ...(actionId === undefined ? {} : { actionId }),
  };
}

function buildActions(
  events: LedgerEvent[],
  contextItems: ContextItem[],
  turnEnded: boolean,
): ActionModel[] {
  const started = new Map<string, Extract<LedgerEvent, { type: 'action.started' }>>();
  const finished = new Map<string, Extract<LedgerEvent, { type: 'action.finished' }>>();
  const blocks: BlockModel[] = [];
  const writes = new Map<string, { path: string; change: 'created' | 'updated' }[]>();

  for (const event of events) {
    const type = eventType(event);
    if (type === 'action.started') {
      const record = event as Extract<LedgerEvent, { type: 'action.started' }>;
      started.set(record.actionId, record);
    } else if (type === 'action.finished') {
      const record = event as Extract<LedgerEvent, { type: 'action.finished' }>;
      finished.set(record.actionId, record);
    } else if (type === 'action.block') {
      const record = event as Extract<LedgerEvent, { type: 'action.block' }>;
      blocks.push({
        blockId: record.blockId,
        text: record.text,
        unterminated: record.unterminated ?? false,
        actionIds: [],
      });
    } else if (type === 'ws.updated') {
      const record = event as Extract<LedgerEvent, { type: 'ws.updated' }>;
      const bucket = writes.get(record.actionId);
      const entry = { path: record.path, change: record.change };
      if (bucket) bucket.push(entry);
      else writes.set(record.actionId, [entry]);
    }
  }

  const startedByBlock = new Set<string>();
  for (const record of started.values()) startedByBlock.add(record.blockId);
  const unmatchedBlocks = new Map<number, BlockModel[]>();
  for (const block of blocks) {
    if (startedByBlock.has(block.blockId)) continue;
    const cycle = blockCycle(events, block.blockId);
    const bucket = unmatchedBlocks.get(cycle);
    if (bucket) bucket.push(block);
    else unmatchedBlocks.set(cycle, [block]);
  }

  const ids = [...new Set([...started.keys(), ...finished.keys()])];
  const actions: ActionModel[] = ids.map((actionId) => {
    const start = started.get(actionId);
    const end = finished.get(actionId);
    const cycle = start?.cycle ?? end?.cycle ?? 0;
    const kind = start ? start.kind : 'parse-failed';
    const id = start ? actionId : (unmatchedBlocks.get(cycle)?.shift()?.blockId ?? actionId);
    const outputs = contextItems.filter((item) => item.actionId === actionId && (item.source === 'action' || item.source === 'project-instructions'));
    const taskRunId = end?.taskRunId ?? start?.taskRunId;
    const status: ItemStatus = end?.status ?? (turnEnded ? 'cancelled' : 'running');
    const copy = describeAction(kind, start?.parsed, end?.result);
    return {
      id,
      kind,
      title: copy.title,
      ...(copy.subtitle === undefined ? {} : { subtitle: copy.subtitle }),
      status,
      startedAt: start?.at ?? end?.at ?? '',
      ...(end?.at === undefined ? {} : { endedAt: end.at }),
      ...(start?.parsed === undefined ? {} : { parsed: start.parsed }),
      ...(end?.result === undefined ? {} : { result: end.result }),
      ...(taskRunId === undefined ? {} : { taskRunId }),
      outputs,
      writes: writes.get(actionId) ?? [],
      afterInterrupt: end?.afterInterrupt ?? false,
      cycle,
    };
  });

  // Link block -> action ids and attach them to the block models.
  const blockById = new Map(blocks.map((block) => [block.blockId, block]));
  for (const record of started.values()) {
    const block = blockById.get(record.blockId);
    if (block) block.actionIds.push(record.actionId);
  }

  return actions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function blockCycle(events: LedgerEvent[], blockId: string): number {
  for (const event of events) {
    if (eventType(event) === 'action.block' && (event as { blockId?: string }).blockId === blockId) return event.cycle ?? 0;
  }
  return 0;
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

  const blockModels: BlockModel[] = [];
  const actionsByBlock = new Map<string, string[]>();
  for (const event of events) {
    const type = eventType(event);
    if (type === 'action.block') {
      const record = event as Extract<LedgerEvent, { type: 'action.block' }>;
      blockModels.push({ blockId: record.blockId, text: record.text, unterminated: record.unterminated ?? false, actionIds: [] });
    } else if (type === 'action.started') {
      const record = event as Extract<LedgerEvent, { type: 'action.started' }>;
      const bucket = actionsByBlock.get(record.blockId);
      if (bucket) bucket.push(record.actionId);
      else actionsByBlock.set(record.blockId, [record.actionId]);
    }
  }
  for (const block of blockModels) block.actionIds = actionsByBlock.get(block.blockId) ?? [];

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
    const reasoning = running
      ? { callId: running.id, text: running.output, ...(running.reasoning ? { thinking: running.reasoning } : {}), streaming: true }
      : committed
        ? {
            callId: committed.id,
            text: committed.output !== '' ? committed.output : reasonCompleted?.text ?? '',
            ...(committed.reasoning ? { thinking: committed.reasoning } : {}),
            streaming: false,
          }
        : reasonCompleted
          ? { callId: reasonCompleted.callId, text: reasonCompleted.text, streaming: false }
          : undefined;

    const progress = cycleEvents
      .filter((event) => eventType(event) === 'reply' && (event as ReplyEvent).phase === 'progress')
      .map((event) => replyModel(event as ReplyEvent));

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
      context: contextItems.filter((item) => cycleOfSeq(events, item.key) === index && item.source === 'selection'),
      ...(reasoning === undefined ? {} : { reasoning }),
      blocks: blockModels.filter((block) => blockCycle(events, block.blockId) === index),
      actionIds: cycleActions.map((action) => action.id),
      progress,
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
  const running = calls.filter((call) => call.status === 'running');
  const reasonRunning = running.find((call) => call.role === 'reason');
  if (reasonRunning) return 'reasoning';
  const replyRunning = running.find((call) => call.role === 'reply');
  if (replyRunning) {
    const hasActions = actions.some((action) => action.cycle === replyRunning.cycle);
    return hasActions ? 'acting' : 'replying';
  }
  if (actions.some((action) => action.status === 'running')) return 'acting';

  // Fallback used before the live layer provides running calls: infer from events.
  let phase: Phase = 'preparing';
  for (const event of events) {
    const type = eventType(event);
    if (type === 'call' && (event as CallEvent).role === 'select') phase = 'preparing';
    if (type === 'context.selected' || type === 'action.block') phase = 'reasoning';
    if (type === 'action.started') phase = 'acting';
    if (type === 'reason.completed') {
      const hasBlock = events.some((other) => other.cycle === event.cycle && eventType(other) === 'action.block');
      phase = hasBlock ? 'acting' : 'replying';
    }
    if (type === 'reply' && (event as ReplyEvent).phase === 'final') phase = 'replying';
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
    docsWritten: events.filter((event) => eventType(event) === 'ws.updated').length,
  };
}
