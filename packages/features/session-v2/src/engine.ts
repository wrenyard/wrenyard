/**
 * session-v2 engine: the work-turn state machine.
 *
 * Cross-module contract (implemented by the concurrent sibling tasks):
 *
 *   ledger.ts    owns the append-only timeline. Its `Ledger` class is adapted to
 *                {@link LedgerPort} and its event/snapshot types are imported
 *                directly because the spec fixes their shapes.
 *   workspace.ts owns the read-only file source, path validation, snapshot
 *                generation and the project instruction chain. Adapted to
 *                {@link FilesPort} / {@link EnginePorts.createSnapshot}.
 *   views.ts     owns prompt assembly, event rendering/escaping and layer
 *                character statistics. Adapted to {@link ViewsPort}.
 *   calls.ts     owns role→model resolution, model metadata, the budget check,
 *                timeouts and `call` event writing. Adapted to {@link CallsPort}.
 *   driver.ts    owns the single gateway streaming request, used by calls.ts.
 *
 * `index.ts` is the only composition root: it builds the ports from those
 * sibling modules and hands them to {@link createEngine}. Keeping the concrete
 * wiring there means this file and `actions.ts` stay self-contained.
 */

import { randomUUID } from 'node:crypto';

import type { WrenyardGatewayConnection, WrenyardGatewayModel } from '@wrenyard/control-client';
import type {
  LedgerEvent,
  LedgerEventDraft,
  SessionSummary,
  TaskBrief,
  TurnStatus,
  WorkspaceSnapshot,
} from './ledger.ts';
import { resolveModelMetadata, type CallRole } from './calls.ts';
import type { ModelMessage, Usage } from './driver.ts';
import {
  ActionRunner,
  ActionSplitter,
  type ActionExecutionOutcome,
  type ActionKind,
  type ActionStatus,
  type DocType,
  type ParsedAction,
} from './actions.ts';

export const MAX_CYCLES = 10;
const PROGRESS_MERGE_MS = 3000;

// ─── Public host and session surface ───────────────────────────────────────

export interface ProjectInfo {
  id: string;
  displayName?: string;
  workspaceDir: string;
  checkoutPath?: string;
  gitRemote?: string;
  defaultBranch?: string;
}

export interface SessionV2Host {
  workspaceRoot: string;
  stateRoot: string;
  deviceName: string;
  gateway(): Promise<WrenyardGatewayConnection>;
  cheapModel(): Promise<string>;
  listProjects(): Promise<ProjectInfo[]>;
  gitHead(checkoutPath: string): Promise<{ branch?: string; head?: string }>;
  listTaskDefinitions(): Promise<{ id: string; description: string; project?: string }[]>;
  describeTask(id: string, project?: string): Promise<{ description: string; inputSchema: unknown }>;
  createTaskRun(params: {
    task: string;
    project?: string;
    input: unknown;
    ctx?: Record<string, unknown>;
  }): Promise<{ taskRunId: string }>;
  waitTaskRun(taskRunId: string, signal: AbortSignal): Promise<{ status: string; output: string }>;
  cancelTaskRun(taskRunId: string): Promise<void>;
  createWorkspaceDoc(path: string, content: string): Promise<void>;
  updateWorkspaceDoc(path: string, content: string, expectedContent: string): Promise<void>;
  now?(): Date;
}

export interface SessionV2 {
  createSession(): Promise<{ sessionId: string }>;
  listSessions(): SessionSummary[];
  send(
    sessionId: string,
    input: { text: string; model: { provider: string; model: string; reasoningEffort?: string } },
  ): Promise<{ turn: number }>;
  interrupt(sessionId: string, turn: number): Promise<void>;
  /** Admitted turns whose terminal `turn.finished` is not yet durable. */
  activeTurnCount(): number;
  readLedger(sessionId: string): LedgerEvent[];
  subscribe(sessionId: string, listener: (event: LedgerEvent) => void): () => void;
  close(): Promise<void>;
}

// ─── Ports (concrete wiring lives in index.ts) ─────────────────────────────

export interface LedgerPort {
  init(): Promise<void>;
  append(sessionId: string, draft: LedgerEventDraft): Promise<LedgerEvent>;
  read(sessionId: string): LedgerEvent[];
  listSessions(): SessionSummary[];
  subscribe(sessionId: string, listener: (event: LedgerEvent) => void): () => void;
  close(): Promise<void>;
}

export interface RecalledFile {
  path: string;
  title: string;
  content: string;
}

export interface FilesPort {
  /** Validate a workspace-relative path against the read/write scope. */
  checkPath(path: string): { ok: true; kind: 'memory' | 'doc' } | { ok: false; reason: string };
  exists(path: string): boolean;
  /** Read a validated path; undefined when it is missing or unreadable. */
  read(path: string): RecalledFile | undefined;
  /** Existing project instruction files, outermost first. */
  instructionChain(workspaceDir: string, docPath: string): string[];
}

export interface SnapshotProjectInput {
  id: string;
  displayName?: string;
  workspaceDir: string;
  checkoutPath?: string;
  gitRemote?: string;
  defaultBranch?: string;
  branch?: string;
  head?: string;
  tasks: TaskBrief[];
}

export interface SnapshotInput {
  workspaceRoot: string;
  deviceName: string;
  takenAt: Date;
  projects: SnapshotProjectInput[];
  builtinTasks: TaskBrief[];
}

export interface ViewMessage {
  role: 'system' | 'user';
  content: string;
}

export interface BuiltView {
  messages: ViewMessage[];
  /** Character count per prompt layer, for the `call` event. */
  layers: Record<string, number>;
}

export type TurnPhase = 'preparing' | 'reasoning' | 'acting' | 'replying' | 'terminal';

export interface SessionViewInfo {
  now?: string;
  sessionId: string;
  turn: number;
  cycle: number;
  maxCycles: number;
  model: string;
  deviceName: string;
  contextWindow?: number;
}

export interface RunningActionInfo {
  actionId: string;
  turn: number;
  kind: ActionKind;
  goal: string;
  startedAt: string;
  taskRunId?: string;
}

export interface RunningTurnInfo {
  turn: number;
  phase: TurnPhase;
  actions: RunningActionInfo[];
}

export interface ReasonViewInput {
  workspaceRoot: string;
  deviceName: string;
  snapshot: WorkspaceSnapshot;
  events: LedgerEvent[];
  userText: string;
  session: SessionViewInfo;
  runningTurns: RunningTurnInfo[];
}

export interface SelectViewInput {
  snapshot: WorkspaceSnapshot;
  events: LedgerEvent[];
  userText: string;
  loadedPaths: string[];
  session: SessionViewInfo;
  cycle: number;
}

export interface ReplyViewInput {
  phase: 'progress' | 'final';
  snapshot: WorkspaceSnapshot;
  events: LedgerEvent[];
  userText: string;
  session: SessionViewInfo;
  runningTurns: RunningTurnInfo[];
  status?: TurnStatus;
  error?: string;
}

export interface TitleViewInput {
  userText: string;
  finalReply?: string;
}

export interface InterpretViewInput {
  blockText: string;
  unterminated: boolean;
  cycleText: string;
  userText: string;
  projects: ProjectInfo[];
  tasks: { id: string; description: string; project?: string }[];
  scopeRules: string;
  previousFailure?: string;
}

export interface CompileViewInput {
  task: { id: string; description: string; inputSchema: unknown };
  action: Extract<ParsedAction, { kind: 'dispatch' }>;
  userText: string;
  events: LedgerEvent[];
  providers: { provider: string; model: string }[];
  previousFailure?: string;
}

export interface WriteDocViewInput {
  globalAgents: string;
  snapshot: WorkspaceSnapshot;
  events: LedgerEvent[];
  pendingRecalls: LedgerEventDraft[];
  project: { id: string; workspaceDir: string; displayName?: string };
  docType: DocType;
  date: string;
  currentContent?: string;
  outline: string;
}

export interface ViewsPort {
  reason(input: ReasonViewInput): BuiltView;
  select(input: SelectViewInput): BuiltView;
  reply(input: ReplyViewInput): BuiltView;
  title(input: TitleViewInput): BuiltView;
  interpret(input: InterpretViewInput): BuiltView;
  compile(input: CompileViewInput): BuiltView;
  writeDoc(input: WriteDocViewInput): BuiltView;
}

export interface CallRunRequest {
  callId: string;
  role: CallRole;
  turn?: number;
  cycle?: number;
  messages: readonly ModelMessage[];
  layers: Record<string, number>;
  /** Required for the `reason` role; ignored for every other role. */
  reason?: { provider: string; model: string; reasoningEffort?: string };
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
}

export interface CallRunResult {
  model: string;
  text: string;
  reasoning?: string;
  usage?: Usage;
}

/** Structural match for `calls.ts`'s `CallRunner`. */
export interface CallsPort {
  run(input: CallRunRequest): Promise<CallRunResult>;
}

/**
 * The committed-recall gate. `has` and `claim` both answer from the recalls
 * already published to the timeline: `claim` reports whether the path is new
 * but never reserves it, so nothing is poisoned by a read that never lands.
 * The engine alone decides what becomes a committed recall, at publish time.
 */
export interface RecallGate {
  has(path: string): boolean;
  claim(path: string): boolean;
}

/**
 * Everything an action needs except its own id and task-run hook; the engine
 * supplies both per action. `currentEvents` / `currentCycleText` are read at
 * each cheap request, so an action always sees the timeline as of now.
 */
export type ActionBaseContext = Omit<ActionRunContext, 'actionId' | 'onTaskRun'>;

export interface ActionRunContext {
  turn: number;
  cycle: number;
  actionId: string;
  userText: string;
  snapshot: WorkspaceSnapshot;
  currentEvents(): LedgerEvent[];
  currentCycleText(): string;
  runningTurns: RunningTurnInfo[];
  session: SessionViewInfo;
  projects: ProjectInfo[];
  tasks: { id: string; description: string; project?: string }[];
  scopeRules: string;
  providers: { provider: string; model: string }[];
  signal: AbortSignal;
  recalls: RecallGate;
  /**
   * Called by a dispatch action as soon as it created a task run, before it
   * waits. The engine records the run id (a second `action.started` carrying it)
   * and cancels the run immediately when the turn is already aborted.
   */
  onTaskRun(taskRunId: string): Promise<void>;
}

export interface EnginePorts {
  ledger: LedgerPort;
  createSnapshot(input: SnapshotInput): Promise<WorkspaceSnapshot>;
  files(snapshot: WorkspaceSnapshot, workspaceRoot: string): FilesPort;
  views: ViewsPort;
  /** Session-scoped so a `call` event lands on the right timeline. */
  calls(sessionId: string): CallsPort;
}

// ─── Internal runtime state ────────────────────────────────────────────────

/** Committed recalls only: `mark` is called by the engine at publish time. */
class RecallGateImpl implements RecallGate {
  private readonly paths = new Set<string>();
  has(path: string): boolean {
    return this.paths.has(path);
  }
  claim(path: string): boolean {
    return !this.paths.has(path);
  }
  mark(path: string): void {
    this.paths.add(path);
  }
  list(): string[] {
    return [...this.paths];
  }
}

interface RuntimeAction {
  actionId: string;
  turn: number;
  cycle: number;
  kind: ActionKind;
  goal: string;
  startedAt: string;
  taskRunId?: string;
}

interface ResultBundle {
  finished: LedgerEventDraft;
  deferred: LedgerEventDraft[];
}

interface TurnRuntime {
  turn: number;
  userText: string;
  model: { provider: string; model: string; reasoningEffort?: string };
  publicId: string;
  contextWindow?: number;
  phase: TurnPhase;
  status?: TurnStatus;
  cycle: number;
  abort: AbortController;
  actions: Map<string, RuntimeAction>;
  finished: boolean;
  /** Unlike `finished`, this flag changes only after the terminal append. */
  durableTerminal: boolean;
  resultQueue: ResultBundle[];
  flushPromise: Promise<void>;
  /** Set when reasoning failed: late results are still recorded, reads are not. */
  dropDeferred: boolean;
  reasonCompleted: boolean;
  actionsThisCycle: number;
  blocksThisCycle: number;
  actionSeq: number;
  /** Blocks being parsed/started; separate from the executions they spawn. */
  parsePromises: Set<Promise<void>>;
  actionPromises: Set<Promise<void>>;
  /** Serializes progress and final replies so they never interleave. */
  replyChain: Promise<void>;
  cycleText: string;
  taskRunIds: Set<string>;
  progressTimer?: ReturnType<typeof setTimeout>;
  progressPending: boolean;
}

interface SessionRuntime {
  sessionId: string;
  workspaceRoot: string;
  snapshot: WorkspaceSnapshot;
  files: FilesPort;
  actions: ActionRunner;
  calls: CallsPort;
  callSeq: number;
  title: string;
  lastTitleVersion: number;
  titleVersion: number;
  titleUpdatedWithReply: boolean;
  firstUserText?: string;
  turns: Map<number, TurnRuntime>;
  nextTurn: number;
  recalls: RecallGateImpl;
  recallQueue: Promise<void>;
}

const SCOPE_RULES = [
  'Readable: root `memories/*.md` except INDEX.md and `projects/<qualified-name>/docs/**/*.md` only.',
  'Writable: project docs via the write-doc action only (root `docs/`, other `instructions/*.md` and project `instructions/` are rejected).',
  'Paths must be workspace-relative Markdown without `..`, NUL or absolute forms; project instruction files load automatically.',
].join(' ');

// ─── Engine ────────────────────────────────────────────────────────────────

export function createEngine(host: SessionV2Host, ports: EnginePorts): SessionV2 {
  return new Engine(host, ports);
}

class Engine implements SessionV2 {
  private readonly host: SessionV2Host;
  private readonly ports: EnginePorts;
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly ensuring = new Map<string, Promise<SessionRuntime>>();
  private readonly recoveringTurns = new Set<string>();
  private readonly pipeline = new Set<Promise<unknown>>();
  private gatewayModelsPromise?: Promise<WrenyardGatewayModel[]>;
  private ready: Promise<void>;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(host: SessionV2Host, ports: EnginePorts) {
    this.host = host;
    this.ports = ports;
    for (const summary of ports.ledger.listSessions()) {
      let events: LedgerEvent[];
      try {
        events = ports.ledger.read(summary.sessionId);
      } catch {
        // An unreadable timeline is skipped by recovery too; it must not block startup.
        continue;
      }
      for (const event of events) {
        const key = `${summary.sessionId}:${event.turn}`;
        if (event.type === 'turn.started') this.recoveringTurns.add(key);
        else if (event.type === 'turn.finished') this.recoveringTurns.delete(key);
      }
    }
    this.ready = this.initialize();
    void this.ready.catch(() => undefined);
  }

  /**
   * Recover every stored session at startup, not only the ones a later `send`
   * touches: a restart must cancel task runs orphaned by any session.
   */
  private async initialize(): Promise<void> {
    await this.ports.ledger.init();
    for (const summary of this.ports.ledger.listSessions()) {
      await this.recoverSession(summary.sessionId).catch(() => {
        // Nothing runs for a turn whose recovery failed, so it is not active work.
        const prefix = `${summary.sessionId}:`;
        for (const key of this.recoveringTurns) {
          if (key.startsWith(prefix)) this.recoveringTurns.delete(key);
        }
      });
    }
  }

  async createSession(): Promise<{ sessionId: string }> {
    this.assertOpen();
    await this.ready;
    const takenAt = this.now();
    const projects = await this.host.listProjects();
    const taskDefinitions = await this.host.listTaskDefinitions();

    const snapshotProjects: SnapshotProjectInput[] = [];
    for (const project of projects) {
      const head = project.checkoutPath ? await this.host.gitHead(project.checkoutPath) : {};
      snapshotProjects.push({
        id: project.id,
        ...(project.displayName === undefined ? {} : { displayName: project.displayName }),
        workspaceDir: project.workspaceDir,
        ...(project.checkoutPath === undefined ? {} : { checkoutPath: project.checkoutPath }),
        ...(project.gitRemote === undefined ? {} : { gitRemote: project.gitRemote }),
        ...(project.defaultBranch === undefined ? {} : { defaultBranch: project.defaultBranch }),
        ...(head.branch === undefined ? {} : { branch: head.branch }),
        ...(head.head === undefined ? {} : { head: head.head }),
        tasks: taskDefinitions
          .filter((definition) => definition.project === project.id)
          .map((definition) => ({ id: definition.id, description: definition.description })),
      });
    }

    const snapshot = await this.ports.createSnapshot({
      workspaceRoot: this.host.workspaceRoot,
      deviceName: this.host.deviceName,
      takenAt,
      projects: snapshotProjects,
      builtinTasks: taskDefinitions
        .filter((definition) => definition.project === undefined)
        .map((definition) => ({ id: definition.id, description: definition.description })),
    });

    const sessionId = randomUUID();
    this.assertOpen();
    this.registerSession(sessionId, this.host.workspaceRoot, snapshot);
    await this.ports.ledger.append(sessionId, {
      type: 'session.created',
      workspaceRoot: this.host.workspaceRoot,
      snapshot,
    });
    return { sessionId };
  }

  listSessions(): SessionSummary[] {
    return this.ports.ledger.listSessions();
  }

  async send(
    sessionId: string,
    input: { text: string; model: { provider: string; model: string; reasoningEffort?: string } },
  ): Promise<{ turn: number }> {
    this.assertOpen();
    const session = await this.ensureSession(sessionId);
    const publicId = `${input.model.provider}/${input.model.model}`;
    this.assertOpen();
    const metadata = resolveModelMetadata(publicId);
    if (
      input.model.reasoningEffort !== undefined
      && metadata.thinkingLevels !== undefined
      && !metadata.thinkingLevels.some((level) => level === input.model.reasoningEffort)
    ) {
      throw new Error(
        `reasoningEffort '${input.model.reasoningEffort}' is not supported by ${publicId}; expected one of ${metadata.thinkingLevels.join(', ')}`,
      );
    }

    // Turn numbers are assigned synchronously here, so concurrent sends take
    // their numbers in invocation order rather than in resolution order.
    const turnNumber = session.nextTurn;
    session.nextTurn += 1;
    const turn = this.createTurn(turnNumber, input.text, input.model, publicId, metadata.contextWindow);
    session.turns.set(turnNumber, turn);
    if (session.firstUserText === undefined) session.firstUserText = input.text;

    // Durable start: the user event is on disk before `send` returns.
    try {
      await this.ports.ledger.append(sessionId, {
        type: 'turn.started',
        turn: turnNumber,
        text: input.text,
        model: input.model,
      });
    } catch (error) {
      // A turn whose start never reached the timeline was never admitted:
      // forget it so it is not counted active and cannot be interrupted.
      session.turns.delete(turnNumber);
      throw error;
    }

    this.track(this.runTurn(session, turn));
    return { turn: turnNumber };
  }

  async interrupt(sessionId: string, turn: number): Promise<void> {
    this.assertOpen();
    const operation = this.interruptTurn(sessionId, turn, 'user');
    this.track(operation);
    await operation;
  }

  private async interruptTurn(
    sessionId: string,
    turn: number,
    reason: 'user' | 'shutdown',
  ): Promise<void> {
    const session = await this.ensureSession(sessionId);
    const runtime = session.turns.get(turn);
    if (!runtime || runtime.finished) return;

    // Flip the terminal flag synchronously so an in-flight continuation cannot
    // race this interrupt into writing a second `turn.finished`.
    runtime.status = 'interrupted';
    runtime.phase = 'terminal';
    runtime.finished = true;
    // Late action results are appended immediately, flagged as post-interrupt.
    runtime.reasonCompleted = true;

    await this.ports.ledger.append(sessionId, { type: 'turn.interrupted', turn, reason });
    runtime.abort.abort();
    await Promise.allSettled([...runtime.taskRunIds].map((id) => this.safeCancelTask(id)));
    await this.flushResults(session, runtime);
    await this.ports.ledger.append(sessionId, { type: 'turn.finished', turn, status: 'interrupted' });
    runtime.durableTerminal = true;
  }

  activeTurnCount(): number {
    let count = this.recoveringTurns.size;
    for (const session of this.sessions.values()) {
      for (const turn of session.turns.values()) {
        if (!turn.durableTerminal) count += 1;
      }
    }
    return count;
  }

  readLedger(sessionId: string): LedgerEvent[] {
    return this.ports.ledger.read(sessionId);
  }

  subscribe(sessionId: string, listener: (event: LedgerEvent) => void): () => void {
    return this.ports.ledger.subscribe(sessionId, listener);
  }

  async close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    await this.ready.catch(() => undefined);
    for (const sessionId of [...this.sessions.keys()]) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      for (const turn of [...session.turns.values()]) {
        if (!turn.finished) {
          await this.interruptTurn(sessionId, turn.turn, 'shutdown').catch(() => undefined);
        } else if (!turn.abort.signal.aborted) {
          // Abort post-final calls (title) that no interrupt reaches.
          turn.abort.abort();
        }
      }
    }
    // Let every tracked pipeline settle before the timeline is closed.
    while (this.pipeline.size > 0) {
      await Promise.allSettled([...this.pipeline]);
    }
    await this.ports.ledger.close();
  }

  // ── session lifecycle ───────────────────────────────────────────────────

  private registerSession(sessionId: string, workspaceRoot: string, snapshot: WorkspaceSnapshot): SessionRuntime {
    const files = this.ports.files(snapshot, workspaceRoot);
    const calls = this.ports.calls(sessionId);
    const session: SessionRuntime = {
      sessionId,
      workspaceRoot,
      snapshot,
      files,
      actions: new ActionRunner({
        host: this.host,
        files,
        views: this.ports.views,
        calls,
        now: () => this.now(),
      }),
      calls,
      callSeq: 0,
      title: '新会话',
      lastTitleVersion: 0,
      titleVersion: 0,
      titleUpdatedWithReply: false,
      turns: new Map(),
      nextTurn: 1,
      recalls: new RecallGateImpl(),
      recallQueue: Promise.resolve(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  /** Single-flight session recovery so concurrent callers share one replay. */
  private async ensureSession(sessionId: string): Promise<SessionRuntime> {
    await this.ready;
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    await this.ready;
    const registered = this.sessions.get(sessionId);
    if (registered) return registered;

    let pending = this.ensuring.get(sessionId);
    if (!pending) {
      pending = this.recoverSession(sessionId);
      this.ensuring.set(sessionId, pending);
      void pending.catch(() => undefined).finally(() => {
        if (this.ensuring.get(sessionId) === pending) this.ensuring.delete(sessionId);
      });
    }
    return pending;
  }

  /** Rebuild a session runtime from its stored timeline. */
  private async recoverSession(sessionId: string): Promise<SessionRuntime> {
    const events = this.ports.ledger.read(sessionId);
    const created = events.find((event) => event.type === 'session.created');
    if (!created) throw new Error(`unknown session: ${sessionId}`);
    const workspaceRoot = (created as { workspaceRoot: string }).workspaceRoot;
    const snapshot = (created as { snapshot: WorkspaceSnapshot }).snapshot;
    const session = this.registerSession(sessionId, workspaceRoot, snapshot);
    this.replay(session, events);
    await this.recover(session, events);
    return session;
  }

  /** Rebuild cheap derived state (title, dedupe set, next turn) from the ledger. */
  private replay(session: SessionRuntime, events: LedgerEvent[]): void {
    let nextTurn = 1;
    for (const event of events) {
      if (typeof event.turn === 'number' && event.turn >= nextTurn) nextTurn = event.turn + 1;
      switch (event.type) {
        case 'memory.recalled':
        case 'doc.read':
          session.recalls.mark((event as { path: string }).path);
          break;
        case 'title':
          session.title = (event as { text: string }).text;
          session.lastTitleVersion += 1;
          session.titleVersion = session.lastTitleVersion;
          break;
        case 'turn.started':
          if (session.firstUserText === undefined) session.firstUserText = (event as { text: string }).text;
          break;
        case 'reply':
          if ((event as { phase: string }).phase === 'final') session.titleUpdatedWithReply = true;
          break;
        default:
          break;
      }
    }
    session.nextTurn = nextTurn;
  }

  /** Append synthetic interruption for turns the previous process never finished. */
  private async recover(session: SessionRuntime, events: LedgerEvent[]): Promise<void> {
    const started = new Set<number>();
    const finished = new Set<number>();
    const liveTaskRuns = new Map<number, string[]>();

    for (const event of events) {
      if (typeof event.turn !== 'number') continue;
      if (event.type === 'turn.started') started.add(event.turn);
      if (event.type === 'turn.finished') finished.add(event.turn);
      if (event.type === 'action.started' && (event as { taskRunId?: string }).taskRunId) {
        liveTaskRuns.set(event.turn, [...(liveTaskRuns.get(event.turn) ?? []), (event as { taskRunId: string }).taskRunId]);
      }
    }

    for (const turn of started) {
      if (finished.has(turn)) continue;
      await this.ports.ledger.append(session.sessionId, { type: 'turn.interrupted', turn, reason: 'restart' });
      for (const taskRunId of liveTaskRuns.get(turn) ?? []) {
        await this.safeCancelTask(taskRunId);
      }
      await this.ports.ledger.append(session.sessionId, { type: 'turn.finished', turn, status: 'interrupted' });
      this.recoveringTurns.delete(`${session.sessionId}:${turn}`);
    }
  }

  // ── turn state machine ──────────────────────────────────────────────────

  private createTurn(
    turn: number,
    userText: string,
    model: { provider: string; model: string; reasoningEffort?: string },
    publicId: string,
    contextWindow: number | undefined,
  ): TurnRuntime {
    return {
      turn,
      userText,
      model,
      publicId,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      phase: 'preparing',
      cycle: 0,
      abort: new AbortController(),
      actions: new Map(),
      finished: false,
      durableTerminal: false,
      resultQueue: [],
      flushPromise: Promise.resolve(),
      dropDeferred: false,
      reasonCompleted: false,
      actionsThisCycle: 0,
      blocksThisCycle: 0,
      actionSeq: 0,
      parsePromises: new Set(),
      actionPromises: new Set(),
      replyChain: Promise.resolve(),
      cycleText: '',
      taskRunIds: new Set(),
      progressPending: false,
    };
  }

  private async runTurn(session: SessionRuntime, turn: TurnRuntime): Promise<void> {
    try {
      for (let cycle = 1; cycle <= MAX_CYCLES; cycle += 1) {
        if (turn.finished || turn.abort.signal.aborted) return;
        turn.cycle = cycle;
        turn.actionsThisCycle = 0;
        turn.blocksThisCycle = 0;
        turn.actionSeq = 0;
        turn.reasonCompleted = false;
        turn.cycleText = '';

        if (turn.turn === 1 && cycle === 1) this.startInitialTitle(session, turn);

        turn.phase = 'preparing';
        try {
          await this.runSelection(session, turn, cycle);
        } catch (error) {
          await this.appendError(session.sessionId, 'select', messageOf(error), turn);
        }
        if (turn.finished) return;

        turn.phase = 'reasoning';
        const reasoned = await this.runReason(session, turn, cycle);
        if (turn.finished) return;
        if (!reasoned.ok) {
          await this.finishReply(session, turn, 'failed', reasoned.error);
          return;
        }

        turn.phase = 'acting';
        // Reasoning ended and every block is parsed: the started actions are
        // visible now, so send one progress reply before waiting on executions.
        if (turn.actionsThisCycle > 0) this.scheduleProgress(session, turn, true);
        await this.awaitCycleActions(turn);
        if (turn.finished) return;
        if (turn.progressTimer) {
          clearTimeout(turn.progressTimer);
          turn.progressTimer = undefined;
        }
        if (turn.progressPending) {
          turn.progressPending = false;
          this.scheduleProgress(session, turn, true);
        }
        await turn.replyChain;
        if (turn.finished) return;

        if (cycle === MAX_CYCLES) {
          await this.finishReply(session, turn, 'exhausted', undefined);
          return;
        }
        if (turn.actionsThisCycle === 0) {
          await this.finishReply(session, turn, 'completed', undefined);
          return;
        }
      }
    } catch (error) {
      if (!turn.finished) {
        turn.dropDeferred = true;
        turn.reasonCompleted = true;
        turn.abort.abort();
        await this.cancelRunningWork(turn);
        await this.awaitParses(turn);
        await this.awaitCycleActions(turn);
        await this.flushResults(session, turn);
        if (turn.finished) return;
        turn.abort = new AbortController();
        await this.finishReply(session, turn, 'failed', messageOf(error));
      }
    }
  }

  // ── prepare ─────────────────────────────────────────────────────────────

  private async runSelection(session: SessionRuntime, turn: TurnRuntime, cycle: number): Promise<void> {
    const context = this.turnViewContext(session, turn);
    let failure = '';
    // Parse/schema failures get exactly one retry; a failed call is never retried.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = this.ports.views.select({
        snapshot: session.snapshot,
        events: this.ports.ledger.read(session.sessionId),
        userText: turn.userText,
        loadedPaths: session.recalls.list(),
        session: context.session,
        cycle,
      });
      if (failure) {
        const repair = `\n<wy-repair>${failure}</wy-repair>`;
        view.messages[1]!.content += repair;
        view.layers['wy-repair'] = repair.length;
      }
      const outcome = await this.invoke(session, turn, 'select', view);
      if (!outcome.ok) {
        await this.appendError(session.sessionId, 'select', outcome.error ?? 'selection call failed', turn);
        return;
      }

      const selection = parseSelection(outcome.text);
      if (!selection.ok) {
        failure = selection.reason;
        continue;
      }

      await this.ports.ledger.append(session.sessionId, {
        type: 'context.selected',
        turn: turn.turn,
        cycle,
        callId: outcome.callId,
        selections: selection.selections,
      });
      await this.applySelection(session, turn, cycle, selection.selections);
      return;
    }

    await this.appendError(session.sessionId, 'select', failure === '' ? 'selection output could not be parsed' : failure, turn);
  }

  /**
   * Publish the selected files as committed recalls. A selected path that is
   * out of scope or missing is reported instead of being silently dropped.
   */
  private async applySelection(
    session: SessionRuntime,
    turn: TurnRuntime,
    cycle: number,
    selections: SelectionEntry[],
  ): Promise<void> {
    const unusable: string[] = [];
    for (const entry of selections) {
      if (turn.abort.signal.aborted || turn.finished) return;
      const check = session.files.checkPath(entry.path);
      if (!check.ok) {
        unusable.push(`${entry.path} (${check.reason})`);
        continue;
      }
      if (check.kind === 'doc') await this.recallInstructions(session, turn, cycle, entry.path);
      if (turn.finished || turn.abort.signal.aborted) return;
      const file = session.files.read(entry.path);
      if (!file) {
        unusable.push(`${entry.path} (missing)`);
        continue;
      }
      if (check.kind === 'memory') {
        await this.publishRecall(session, {
          type: 'memory.recalled',
          turn: turn.turn,
          cycle,
          path: entry.path,
          content: file.content,
          source: 'selection',
        });
      } else {
        await this.publishRecall(session, {
          type: 'doc.read',
          turn: turn.turn,
          cycle,
          path: entry.path,
          title: file.title,
          content: file.content,
          source: 'selection',
        });
      }
    }
    if (unusable.length > 0) {
      await this.appendError(session.sessionId, 'select', `selection could not be loaded: ${unusable.join(', ')}`, turn);
    }
  }

  /** Publish each not-yet-committed project instruction file, outermost first. */
  private async recallInstructions(
    session: SessionRuntime,
    turn: TurnRuntime,
    cycle: number,
    docPath: string,
  ): Promise<void> {
    const project = projectForDocPath(session.snapshot, docPath);
    if (!project) return;
    const directory = docPath.endsWith('/AGENTS.md') ? docPath.slice(0, -10) : project.workspaceDir;
    for (const instructionPath of session.files.instructionChain(directory, docPath)) {
      if (turn.abort.signal.aborted || turn.finished) return;
      const file = session.files.read(instructionPath);
      if (!file) continue;
      await this.publishRecall(session, {
        type: 'doc.read',
        turn: turn.turn,
        cycle,
        path: instructionPath,
        title: file.title,
        content: file.content,
        source: 'project-instructions',
      });
    }
  }

  // ── reason ──────────────────────────────────────────────────────────────

  private async runReason(
    session: SessionRuntime,
    turn: TurnRuntime,
    cycle: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const context = this.turnViewContext(session, turn);
    const view = this.ports.views.reason({
      workspaceRoot: session.workspaceRoot,
      deviceName: this.host.deviceName,
      snapshot: session.snapshot,
      events: this.ports.ledger.read(session.sessionId),
      userText: turn.userText,
      session: context.session,
      runningTurns: context.runningTurns,
    });

    const splitter = new ActionSplitter();
    const spawn = (block: { text: string; unterminated: boolean }): void => {
      if (turn.finished || turn.abort.signal.aborted) return;
      if (turn.finished) return;
      const promise = this.handleBlock(session, turn, cycle, block).catch((error) =>
        this.appendError(session.sessionId, 'action', messageOf(error), turn),
      );
      turn.parsePromises.add(promise);
      void promise.then(
        () => turn.parsePromises.delete(promise),
        () => turn.parsePromises.delete(promise),
      );
      this.track(promise);
    };

    const outcome = await this.invoke(session, turn, 'reason', view, {
      reason: {
        provider: turn.model.provider,
        model: turn.model.model,
        ...(turn.model.reasoningEffort === undefined ? {} : { reasoningEffort: turn.model.reasoningEffort }),
      },
      onText: (delta) => {
        turn.cycleText += delta;
        for (const block of splitter.push(delta)) spawn(block);
      },
    });

    if (turn.finished) return { ok: false, error: 'interrupted' };

    if (!outcome.ok) {
      // Failed reasoning must not turn the unterminated remainder into new
      // actions. Cancel the work already in flight; its late results are still
      // recorded, but the reads it queued are not published to the context.
      turn.reasonCompleted = true;
      turn.dropDeferred = true;
      turn.abort.abort();
      await this.cancelRunningWork(turn);
      await this.awaitParses(turn);
      await this.awaitCycleActions(turn);
      await this.flushResults(session, turn);
      if (!turn.finished) turn.abort = new AbortController();
      return { ok: false, error: outcome.error ?? 'reason call failed' };
    }

    // Reasoning succeeded, so the unterminated remainder is a real final block.
    for (const block of splitter.finish()) spawn(block);

    await this.ports.ledger.append(session.sessionId, {
      type: 'reason.completed',
      turn: turn.turn,
      cycle,
      callId: outcome.callId,
      text: outcome.text,
    });
    turn.reasonCompleted = true;
    await this.flushResults(session, turn);

    // Wait only for every block to be parsed into started actions here; the
    // executions keep running and are awaited before the next cycle.
    await this.awaitParses(turn);
    return { ok: true };
  }

  private async cancelRunningWork(turn: TurnRuntime): Promise<void> {
    await Promise.allSettled([...turn.taskRunIds].map((id) => this.safeCancelTask(id)));
  }

  private async handleBlock(
    session: SessionRuntime,
    turn: TurnRuntime,
    cycle: number,
    block: { text: string; unterminated: boolean },
  ): Promise<void> {
    const blockId = `b${turn.turn}-${cycle}-${++turn.blocksThisCycle}`;
    await this.ports.ledger.append(session.sessionId, {
      type: 'action.block',
      turn: turn.turn,
      cycle,
      blockId,
      text: block.text,
      ...(block.unterminated ? { unterminated: true } : {}),
    });
    if (turn.finished) return;

    const context = await this.actionBaseContext(session, turn);
    const parsed = await session.actions.parse(block, context);
    if (turn.finished) return;

    if (!parsed.ok) {
      const actionId = `a${turn.turn}-${cycle}-${++turn.actionSeq}`;
      await this.enqueueResult(
        session,
        turn,
        {
          type: 'action.finished',
          turn: turn.turn,
          cycle,
          actionId,
          kind: 'unsupported',
          status: 'failed',
          result: parsed.reason,
        },
        [],
      );
      turn.actionsThisCycle += 1;
      return;
    }

    for (const action of parsed.actions) {
      if (turn.finished) return;
      const actionId = `a${turn.turn}-${cycle}-${++turn.actionSeq}`;
      turn.actionsThisCycle += 1;

      if (cycle === MAX_CYCLES) {
        await this.ports.ledger.append(session.sessionId, {
          type: 'action.started',
          turn: turn.turn,
          cycle,
          actionId,
          blockId,
          kind: action.kind,
          parsed: action,
        });
        await this.enqueueResult(
          session,
          turn,
          {
            type: 'action.finished',
            turn: turn.turn,
            cycle,
            actionId,
            kind: action.kind,
            status: 'skipped',
            result: 'skipped: the final reasoning cycle may not produce actions',
          },
          [],
        );
        continue;
      }

      const runtimeAction: RuntimeAction = {
        actionId,
        turn: turn.turn,
        cycle,
        kind: action.kind,
        goal: describeAction(action),
        startedAt: this.now().toISOString(),
      };
      turn.actions.set(actionId, runtimeAction);
      await this.ports.ledger.append(session.sessionId, {
        type: 'action.started',
        turn: turn.turn,
        cycle,
        actionId,
        blockId,
        kind: action.kind,
        parsed: action,
      });

      const executeContext: ActionRunContext = {
        ...context,
        actionId,
        onTaskRun: (taskRunId: string) =>
          this.recordTaskRun(session, turn, cycle, blockId, actionId, action, runtimeAction, taskRunId),
      };
      const promise = this.runAction(session, turn, action, executeContext, actionId, cycle);
      turn.actionPromises.add(promise);
      void promise.then(
        () => turn.actionPromises.delete(promise),
        () => turn.actionPromises.delete(promise),
      );
      this.track(promise);
    }
  }

  /**
   * Record a dispatch's task run: a second `action.started` with the same
   * id/block/parsed plus `taskRunId`, so a restart can find and cancel it.
   */
  private async recordTaskRun(
    session: SessionRuntime,
    turn: TurnRuntime,
    cycle: number,
    blockId: string,
    actionId: string,
    action: ParsedAction,
    runtimeAction: RuntimeAction,
    taskRunId: string,
  ): Promise<void> {
    runtimeAction.taskRunId = taskRunId;
    turn.taskRunIds.add(taskRunId);
    await this.ports.ledger.append(session.sessionId, {
      type: 'action.started',
      turn: turn.turn,
      cycle,
      actionId,
      blockId,
      kind: action.kind,
      parsed: action,
      taskRunId,
    });
    if (turn.abort.signal.aborted) await this.safeCancelTask(taskRunId);
  }

  /** Execute one action; a thrown execution still records an `action.finished`. */
  private async runAction(
    session: SessionRuntime,
    turn: TurnRuntime,
    action: ParsedAction,
    ctx: ActionRunContext,
    actionId: string,
    cycle: number,
  ): Promise<void> {
    let outcome: ActionExecutionOutcome;
    try {
      outcome = await session.actions.execute(action, ctx);
    } catch (error) {
      outcome = { status: 'failed', result: messageOf(error), deferred: [] };
    }
    turn.actions.delete(actionId);
    if (outcome.taskRunId !== undefined) turn.taskRunIds.add(outcome.taskRunId);

    await this.enqueueResult(
      session,
      turn,
      {
        type: 'action.finished',
        turn: turn.turn,
        cycle,
        actionId,
        kind: action.kind,
        status: outcome.status,
        result: outcome.result,
        ...(action.kind === 'dispatch' ? { task: action.task } : {}),
        ...(outcome.taskStatus === undefined ? {} : { taskStatus: outcome.taskStatus }),
        ...(outcome.taskRunId === undefined ? {} : { taskRunId: outcome.taskRunId }),
        ...(turn.abort.signal.aborted ? { afterInterrupt: true } : {}),
      },
      outcome.deferred,
    );
    if (!turn.finished) this.scheduleProgress(session, turn, false);
  }

  private async awaitParses(turn: TurnRuntime): Promise<void> {
    while (turn.parsePromises.size > 0) {
      await Promise.allSettled([...turn.parsePromises]);
    }
  }

  private async awaitCycleActions(turn: TurnRuntime): Promise<void> {
    while (turn.actionPromises.size > 0) {
      await Promise.allSettled([...turn.actionPromises]);
    }
  }

  // ── result ordering ─────────────────────────────────────────────────────

  private async enqueueResult(
    session: SessionRuntime,
    turn: TurnRuntime,
    finished: LedgerEventDraft,
    deferred: LedgerEventDraft[],
  ): Promise<void> {
    turn.resultQueue.push({ finished, deferred });
    if (turn.reasonCompleted) await this.flushResults(session, turn);
  }

  /**
   * Append queued results, but only once the cycle's `reason.completed` is on
   * the timeline so results always render after the request that produced them.
   * Context reads are routed through {@link publishRecall} so their ledger
   * dedupe is serialized here, at the single point of publication.
   */
  private async flushResults(session: SessionRuntime, turn: TurnRuntime): Promise<void> {
    const work = turn.flushPromise.then(async () => {
      while (turn.reasonCompleted && turn.resultQueue.length > 0) {
        const bundle = turn.resultQueue.shift()!;
        const finished = bundle.finished.type === 'action.finished' && (turn.dropDeferred || turn.abort.signal.aborted)
          ? { ...bundle.finished, afterInterrupt: true } : bundle.finished;
        await this.ports.ledger.append(session.sessionId, finished);
        for (const draft of bundle.deferred) {
          if (isRecallDraft(draft)) {
            // A failed turn still records its late results, but not the reads.
            if (!turn.dropDeferred && !turn.abort.signal.aborted) await this.publishRecall(session, draft);
            continue;
          }
          await this.ports.ledger.append(session.sessionId, draft);
        }
      }
    });
    turn.flushPromise = work.catch(() => undefined);
    await work;
  }

  /**
   * Commit one recall unless the path is already committed. The path is marked
   * synchronously before the append, which serializes concurrent publications.
   */
  private async publishRecall(session: SessionRuntime, draft: LedgerEventDraft): Promise<void> {
    const work = session.recallQueue.then(async () => {
      const owner = draft.turn === undefined ? undefined : session.turns.get(draft.turn);
      if (owner?.finished || owner?.abort.signal.aborted) return;
      const path = (draft as { path?: string }).path;
      if (typeof path === 'string' && session.recalls.has(path)) return;
      await this.ports.ledger.append(session.sessionId, draft);
      if (typeof path === 'string') session.recalls.mark(path);
    });
    session.recallQueue = work.catch(() => undefined);
    await work;
  }

  // ── replies ─────────────────────────────────────────────────────────────

  private scheduleProgress(session: SessionRuntime, turn: TurnRuntime, immediate: boolean): void {
    // Never before the cycle's reasoning has completed, never after the final.
    if (!turn.reasonCompleted) return;
    if (turn.finished || turn.phase === 'replying' || turn.phase === 'terminal') return;
    if (immediate) {
      this.track(this.chainReply(turn, () => this.runProgressReply(session, turn)));
      return;
    }
    turn.progressPending = true;
    if (turn.progressTimer) return;
    turn.progressTimer = setTimeout(() => {
      turn.progressTimer = undefined;
      const pending = turn.progressPending;
      turn.progressPending = false;
      if (!pending) return;
      if (turn.finished || turn.phase === 'replying' || turn.phase === 'terminal') return;
      this.track(this.chainReply(turn, () => this.runProgressReply(session, turn)));
    }, PROGRESS_MERGE_MS);
    turn.progressTimer.unref?.();
  }

  /** Serialize replies per turn so progress and final never interleave. */
  private chainReply(turn: TurnRuntime, task: () => Promise<void>): Promise<void> {
    const run = turn.replyChain.then(task, task);
    turn.replyChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runProgressReply(session: SessionRuntime, turn: TurnRuntime): Promise<void> {
    if (turn.finished || turn.phase === 'terminal' || !turn.reasonCompleted) return;
    const cycle = turn.cycle;
    const context = this.turnViewContext(session, turn);
    const view = this.ports.views.reply({
      phase: 'progress',
      snapshot: session.snapshot,
      events: this.ports.ledger.read(session.sessionId),
      userText: turn.userText,
      session: context.session,
      runningTurns: context.runningTurns,
    });
    const outcome = await this.invoke(session, turn, 'reply', view);
    if (turn.finished || turn.phase === 'replying' || turn.abort.signal.aborted) return;
    await this.ports.ledger.append(session.sessionId, {
      type: 'reply',
      turn: turn.turn,
      cycle,
      phase: 'progress',
      text: outcome.ok ? outcome.text : '工作仍在处理中，暂时无法生成进展说明。',
      callId: outcome.callId,
    });
  }

  private async finishReply(
    session: SessionRuntime,
    turn: TurnRuntime,
    status: TurnStatus,
    error: string | undefined,
  ): Promise<void> {
    if (turn.finished || turn.abort.signal.aborted) return;
    if (turn.progressTimer) {
      clearTimeout(turn.progressTimer);
      turn.progressTimer = undefined;
    }
    turn.phase = 'replying';

    let text: string | undefined;
    let callId: string | undefined;
    if (status !== 'interrupted') {
      await this.chainReply(turn, async () => {
        const context = this.turnViewContext(session, turn);
        const view = this.ports.views.reply({
          phase: 'final',
          snapshot: session.snapshot,
          events: this.ports.ledger.read(session.sessionId),
          userText: turn.userText,
          session: context.session,
          runningTurns: context.runningTurns,
          status,
          ...(error === undefined ? {} : { error }),
        });
        const outcome = await this.invoke(session, turn, 'reply', view);
        if (outcome.ok) {
          text = outcome.text;
          callId = outcome.callId;
        }
      }).catch(() => undefined);
    }

    // An interrupt that landed while the final reply was in flight owns the end.
    if (turn.finished) return;
    if (text === undefined) text = fallbackReply(status, error);

    await this.ports.ledger.append(session.sessionId, {
      type: 'reply',
      turn: turn.turn,
      cycle: turn.cycle,
      phase: 'final',
      text,
      ...(callId === undefined ? {} : { callId }),
    });

    if (turn.finished) return;
    turn.status = status;
    turn.phase = 'terminal';
    turn.finished = true;
    await this.ports.ledger.append(session.sessionId, {
      type: 'turn.finished',
      turn: turn.turn,
      status,
      ...(error === undefined ? {} : { error }),
    });
    turn.durableTerminal = true;

    await this.maybeUpdateTitle(session, turn, text);
  }

  // ── title ───────────────────────────────────────────────────────────────

  private startInitialTitle(session: SessionRuntime, turn: TurnRuntime): void {
    const version = ++session.titleVersion;
    const userText = session.firstUserText ?? turn.userText;
    const promise = (async () => {
      const view = this.ports.views.title({ userText });
      const outcome = await this.invoke(session, turn, 'title', view);
      if (!outcome.ok) return;
      await this.applyTitle(session, version, outcome.callId, outcome.text);
    })();
    this.track(promise);
  }

  private async maybeUpdateTitle(session: SessionRuntime, turn: TurnRuntime, finalReply: string): Promise<void> {
    if (session.titleUpdatedWithReply) return;
    session.titleUpdatedWithReply = true;
    const version = ++session.titleVersion;
    const userText = session.firstUserText ?? turn.userText;
    try {
      const view = this.ports.views.title({ userText, finalReply });
      const outcome = await this.invoke(session, turn, 'title', view);
      if (!outcome.ok) return;
      await this.applyTitle(session, version, outcome.callId, outcome.text);
    } catch {
      // Title updates are best-effort; keep the existing title.
    }
  }

  /** Later title generations always win, so an older slow call cannot overwrite one. */
  private async applyTitle(
    session: SessionRuntime,
    version: number,
    callId: string,
    text: string,
  ): Promise<void> {
    const title = text.trim().split('\n')[0]!.trim();
    if (title === '') return;
    if (version < session.lastTitleVersion) return;
    session.lastTitleVersion = version;
    session.title = title;
    await this.ports.ledger.append(session.sessionId, {
      type: 'title',
      text: title,
      callId,
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private turnViewContext(
    session: SessionRuntime,
    turn: TurnRuntime,
  ): { session: SessionViewInfo; runningTurns: RunningTurnInfo[] } {
    return {
      session: {
        now: this.now().toISOString(),
        sessionId: session.sessionId,
        turn: turn.turn,
        cycle: turn.cycle,
        maxCycles: MAX_CYCLES,
        model: turn.publicId,
        deviceName: this.host.deviceName,
        ...(turn.contextWindow === undefined ? {} : { contextWindow: turn.contextWindow }),
      },
      runningTurns: this.runningTurns(session, -1),
    };
  }

  private async actionBaseContext(session: SessionRuntime, turn: TurnRuntime): Promise<ActionBaseContext> {
    const context = this.turnViewContext(session, turn);
    const tasks = [
      ...session.snapshot.projects.flatMap((project) =>
        project.tasks.map((task) => ({ id: task.id, description: task.description, project: project.id })),
      ),
      ...session.snapshot.builtinTasks.map((task) => ({ id: task.id, description: task.description })),
    ];
    return {
      turn: turn.turn,
      cycle: turn.cycle,
      userText: turn.userText,
      snapshot: session.snapshot,
      currentEvents: () => this.ports.ledger.read(session.sessionId),
      currentCycleText: () => turn.cycleText,
      runningTurns: context.runningTurns,
      session: context.session,
      projects: session.snapshot.projects.map((project) => ({
        id: project.id,
        ...(project.displayName === undefined ? {} : { displayName: project.displayName }),
        workspaceDir: project.workspaceDir,
        ...(project.checkoutPath === undefined ? {} : { checkoutPath: project.checkoutPath }),
        ...(project.gitRemote === undefined ? {} : { gitRemote: project.gitRemote }),
        ...(project.defaultBranch === undefined ? {} : { defaultBranch: project.defaultBranch }),
      })),
      tasks,
      scopeRules: SCOPE_RULES,
      providers: await this.providerList(),
      signal: turn.abort.signal,
      recalls: session.recalls,
    };
  }

  private runningTurns(session: SessionRuntime, excludeTurn: number): RunningTurnInfo[] {
    const running: RunningTurnInfo[] = [];
    for (const candidate of session.turns.values()) {
      if (candidate.finished || candidate.turn === excludeTurn) continue;
      running.push({
        turn: candidate.turn,
        phase: candidate.phase,
        actions: [...candidate.actions.values()].map((action) => ({
          actionId: action.actionId,
          turn: action.turn,
          kind: action.kind,
          goal: action.goal,
          startedAt: action.startedAt,
          ...(action.taskRunId === undefined ? {} : { taskRunId: action.taskRunId }),
        })),
      });
    }
    return running.sort((a, b) => a.turn - b.turn);
  }

  private async appendError(
    sessionId: string,
    stage: string,
    message: string,
    turn: TurnRuntime,
  ): Promise<void> {
    try {
      await this.ports.ledger.append(sessionId, {
        type: 'error',
        stage,
        message,
        ...(turn.turn > 0 ? { turn: turn.turn, cycle: turn.cycle } : {}),
      });
    } catch {
      // Error reporting must never take the pipeline down.
    }
  }

  /** Gateway model catalogue; a failed lookup is not cached. */
  private async gatewayModels(): Promise<WrenyardGatewayModel[]> {
    if (this.gatewayModelsPromise) return this.gatewayModelsPromise;
    const promise = this.host.gateway().then((connection) => connection.models);
    this.gatewayModelsPromise = promise;
    promise.catch(() => {
      if (this.gatewayModelsPromise === promise) this.gatewayModelsPromise = undefined;
    });
    return promise;
  }

  private async providerList(): Promise<{ provider: string; model: string }[]> {
    try {
      const models = await this.gatewayModels();
      return models.map((model) => ({ provider: model.provider, model: model.id }));
    } catch {
      return [];
    }
  }

  /**
   * Run one model call. `calls.ts` writes the `call` event and throws on
   * failure, so every role's failure consequence is decided here.
   */
  private async invoke(
    session: SessionRuntime,
    turn: TurnRuntime,
    role: CallRole,
    view: BuiltView,
    extra: {
      reason?: { provider: string; model: string; reasoningEffort?: string };
      onText?: (delta: string) => void;
      onReasoning?: (delta: string) => void;
    } = {},
  ): Promise<{ ok: boolean; callId: string; text: string; error?: string }> {
    const callId = `c${turn.turn}.${++session.callSeq}`;
    try {
      const result = await session.calls.run({
        callId,
        role,
        turn: turn.turn,
        cycle: turn.cycle,
        messages: view.messages,
        layers: view.layers,
        signal: turn.abort.signal,
        ...(extra.reason === undefined ? {} : { reason: extra.reason }),
        ...(extra.onText === undefined ? {} : { onText: extra.onText }),
        ...(extra.onReasoning === undefined ? {} : { onReasoning: extra.onReasoning }),
      });
      return { ok: true, callId, text: result.text };
    } catch (error) {
      return { ok: false, callId, text: '', error: messageOf(error) };
    }
  }

  private async safeCancelTask(taskRunId: string): Promise<void> {
    try {
      await this.host.cancelTaskRun(taskRunId);
    } catch {
      // Cancellation is best-effort; a stale run id must not fail the turn.
    }
  }

  private track(promise: Promise<unknown>): void {
    this.pipeline.add(promise);
    void promise
      .catch(() => undefined)
      .finally(() => this.pipeline.delete(promise));
  }

  private now(): Date {
    return this.host.now ? this.host.now() : new Date();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('session-v2 is closed');
  }
}

// ─── shared helpers ────────────────────────────────────────────────────────

interface SelectionEntry {
  path: string;
  reason: string;
}

type SelectionResult = { ok: true; selections: SelectionEntry[] } | { ok: false; reason: string };

/** Validate the selector's strict JSON: two arrays of `{ path, reason }`. */
function parseSelection(text: string): SelectionResult {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch (error) {
    return { ok: false, reason: `selection output is not valid JSON: ${messageOf(error)}` };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'selection output must be a JSON object' };
  }

  const record = value as { memories?: unknown; docs?: unknown };
  const selections: SelectionEntry[] = [];
  for (const [group, items] of [['memories', record.memories], ['docs', record.docs]] as const) {
    if (!Array.isArray(items)) return { ok: false, reason: `selection '${group}' must be an array` };
    for (const item of items) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, reason: `selection '${group}' entries must be objects` };
      }
      const path = (item as { path?: unknown }).path;
      if (typeof path !== 'string' || path.trim() === '') {
        return { ok: false, reason: `selection '${group}' entries need a non-empty path` };
      }
      const reason = (item as { reason?: unknown }).reason;
      if (typeof reason !== 'string') {
        return { ok: false, reason: `selection '${group}' reason must be a string` };
      }
      selections.push({ path, reason: reason ?? '' });
    }
  }
  return { ok: true, selections };
}

function isRecallDraft(draft: LedgerEventDraft): boolean {
  const type = (draft as { type?: string }).type;
  return type === 'doc.read' || type === 'memory.recalled';
}

function describeAction(action: ParsedAction): string {
  switch (action.kind) {
    case 'dispatch':
      return `dispatch ${action.project ? `${action.project}/` : ''}${action.task}: ${oneLine(action.goal)}`;
    case 'read':
      return `read ${action.paths.join(', ')}`;
    case 'write-doc':
      return `write-doc ${action.project} ${action.docType}: ${oneLine(action.outline)}`;
    case 'unsupported':
      return `unsupported: ${oneLine(action.reason)}`;
  }
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  return collapsed;
}

function projectForDocPath(snapshot: WorkspaceSnapshot, docPath: string) {
  const matches = snapshot.projects.filter((project) => docPath.startsWith(`${project.workspaceDir}/`)
    || (docPath.endsWith('/AGENTS.md') && project.workspaceDir.startsWith(`${docPath.slice(0, -10)}/`)));
  if (matches.length === 0) return undefined;
  return matches.reduce((longest, candidate) =>
    candidate.workspaceDir.length > longest.workspaceDir.length ? candidate : longest,
  );
}

/** Fixed-format fallback used when the communication call itself fails. */
export function fallbackReply(status: TurnStatus, error: string | undefined): string {
  switch (status) {
    case 'failed':
      return `处理没有完成。错误：${error ?? '未知错误'}。如需继续，请告诉我下一步要做什么。`;
    case 'exhausted':
      return '已达到本轮的最大推理次数，仍有未完成的部分。请告诉我优先继续哪一部分。';
    case 'interrupted':
      return '本轮已中断。';
    default:
      return '本轮已结束。';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { ActionStatus, DocType, ParsedAction };
