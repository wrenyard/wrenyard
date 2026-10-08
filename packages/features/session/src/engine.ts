/**
 * session engine: the work-turn state machine (current-only).
 *
 * Cross-module contract (implemented by the concurrent sibling tasks):
 *
 *   ledger.ts    owns the append-only timeline. Its `Ledger` class is adapted to
 *                {@link LedgerPort} and its event/snapshot types are imported
 *                directly because the spec fixes their shapes.
 *   workspace.ts owns the read-only file source, the document catalogue and the
 *                snapshot. Adapted to {@link FilesPort} / {@link SnapshotInput}.
 *   views.ts     owns prompt assembly, event rendering/escaping and layer
 *                character statistics. Adapted to {@link ViewsPort}.
 *   calls.ts     owns role→model resolution, model metadata, the budget check,
 *                timeouts and `call` event writing. Adapted to {@link CallsPort}.
 *   driver.ts    owns the single gateway streaming request, used by calls.ts.
 *   actions.ts   owns the reason action contract and execution.
 *   documents.ts owns the `doc.content` reconstruction helpers.
 *   media.ts     owns the session file store.
 *   ports.ts     declares the host surface and the ports above.
 *   runtime.ts   declares the in-memory session and turn state.
 *   replies.ts   owns the progress/final replies and the session title.
 *   live.ts      owns the streaming snapshots of running calls.
 *
 * `index.ts` is the only composition root: it builds the ports and hands them to
 * {@link createEngine}. There is no compatibility mechanism and no legacy role.
 */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  collectSessionFiles,
  CURRENT_SESSION_FORMAT,
  contextImageFiles,
  type LedgerEvent,
  type LedgerEventDraft,
  type SessionCreatedEvent,
  type SessionSummary,
  type WorkspaceSnapshot,
} from './ledger.ts';
import { ModelCallError, resolveModelMetadata, type CallRole } from './calls.ts';
import { REASONING_EFFORTS, type ReasoningEffort } from '@wrenyard/models';
import { contentVersion } from './documents.ts';
import { ContextInspector, type ContextInspectRequest, type ContextInspection } from './context-inspect.ts';
import { type ToolCall } from './driver.ts';
import type { AttachmentInput, FileStore } from './media.ts';
import {
  actionFromToolCall,
  ActionRunner,
  type ActionExecutionOutcome,
  type ActionRunContext,
  type ParsedAction,
} from './actions.ts';
import type { BuiltView } from './views.ts';
import { LiveCalls } from './live.ts';
import type {
  ActionBaseContext,
  EnginePorts,
  LiveCall,
  Session,
  SessionHost,
  SessionViewInfo,
  SnapshotProjectInput,
} from './ports.ts';
import { latestReasonText, ReplyWriter } from './replies.ts';
import type { RuntimeAction, SessionRuntime, TurnRuntime } from './runtime.ts';

export type {
  BuiltView,
  CompileViewInput,
  DocSearchViewInput,
  MemorySearchViewInput,
  ReasonViewInput,
  ReplyViewInput,
  TitleViewInput,
  ViewMessage,
  ViewsPort,
} from './views.ts';
export type * from './ports.ts';
export { fallbackReply } from './replies.ts';

/** How much of one action result the memory-search view carries. */
const ACTION_RESULT_EXCERPT = 200;

/** An unsupported (pre-current) session format is never recovered or migrated. */
const OLD_SESSION_FORMAT_ERROR = '此会话使用旧格式，记录已保留。请新建会话。';

// ─── Engine ────────────────────────────────────────────────────────────────

export function createEngine(host: SessionHost, ports: EnginePorts): Session {
  return new Engine(host, ports);
}

class Engine implements Session {
  private readonly host: SessionHost;
  private readonly ports: EnginePorts;
  private readonly inspector: ContextInspector;
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly live = new LiveCalls();
  private readonly replies: ReplyWriter;
  private readonly ensuring = new Map<string, Promise<SessionRuntime>>();
  private readonly recoveringTurns = new Set<string>();
  /**
   * Per-session count of in-flight attachment imports/admissions. A plain Set
   * was wrong: two concurrent imports of the same session would let the first
   * `finally` drop the flag while the second was still copying bytes, so a
   * concurrent delete could remove the files directory out from under it.
   */
  private readonly pendingAdmissions = new Map<string, number>();
  /** Sessions deleted in this process; a stale send must not resurrect one. */
  private readonly deletedSessions = new Set<string>();
  private readonly pipeline = new Set<Promise<unknown>>();
  private ready: Promise<void>;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(host: SessionHost, ports: EnginePorts) {
    this.host = host;
    this.ports = ports;
    this.replies = new ReplyWriter(ports, this, host.deviceName);
    this.inspector = new ContextInspector({
      workspaceRoot: host.workspaceRoot,
      deviceName: host.deviceName,
      views: ports.views,
      ledger: ports.ledger,
      now: () => this.now(),
      createSnapshot: () => this.buildSnapshot(),
    });
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
   * touches: a restart must cancel task runs orphaned by any session. A session
   * in an unsupported historical format is skipped without being rewritten.
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
    const snapshot = await this.buildSnapshot();

    const sessionId = randomUUID();
    this.assertOpen();
    this.registerSession(sessionId, this.host.workspaceRoot, snapshot);
    await this.ports.ledger.append(sessionId, {
      type: 'session.created',
      format: CURRENT_SESSION_FORMAT,
      workspaceRoot: this.host.workspaceRoot,
      snapshot,
    });
    return { sessionId };
  }

  /**
   * Build the frozen workspace snapshot a new session would take right now.
   * Shared by `createSession` and the new-session context inspection, so both
   * freeze the same facts instead of inspecting a different shape.
   */
  private async buildSnapshot(): Promise<WorkspaceSnapshot> {
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
          .map((definition) => ({
            id: definition.id,
            description: definition.description,
            inputSummary: definition.inputSummary,
          })),
      });
    }

    return this.ports.createSnapshot({
      workspaceRoot: this.host.workspaceRoot,
      deviceName: this.host.deviceName,
      takenAt,
      projects: snapshotProjects,
      builtinTasks: taskDefinitions
        .filter((definition) => definition.project === undefined)
        .map((definition) => ({
          id: definition.id,
          description: definition.description,
          inputSummary: definition.inputSummary,
        })),
    });
  }

  listSessions(): SessionSummary[] {
    return this.ports.ledger.listSessions();
  }

  async send(
    sessionId: string,
    input: {
      text: string;
      /** Explicit public reasoning level; required for every turn. */
      model: { provider: string; model: string; reasoningEffort: ReasoningEffort };
      attachments?: AttachmentInput[];
    },
  ): Promise<{ turn: number }> {
    this.assertOpen();
    // Requires the current-format marker before any import, copy or append.
    const session = await this.ensureSession(sessionId);
    const publicId = `${input.model.provider}/${input.model.model}`;
    this.assertOpen();
    const metadata = resolveModelMetadata(publicId);
    const effort = input.model.reasoningEffort;
    if (effort === undefined || !REASONING_EFFORTS.includes(effort)) {
      throw new Error(`reasoningEffort '${effort ?? ''}' is not a valid reasoning effort`);
    }
    if (metadata.reasoningEfforts !== undefined && !metadata.reasoningEfforts.includes(effort)) {
      throw new Error(
        `reasoningEffort '${effort}' is not supported by ${publicId}; expected one of ${metadata.reasoningEfforts.join(', ')}`,
      );
    }

    // A deletion that completed while this send was waiting on the session lock
    // must not be undone by admitting a turn after the fact.
    this.assertNotDeleted(sessionId);

    // Hold an admission for the whole import so a concurrent delete cannot
    // remove the session (and its files directory) out from under this send.
    this.beginAdmission(sessionId);
    let files: Awaited<ReturnType<FileStore['importAttachments']>>;
    try {
      files = input.attachments === undefined || input.attachments.length === 0
        ? []
        : await this.ports.fileStore.importAttachments(sessionId, input.attachments);
    } finally {
      this.endAdmission(sessionId);
    }
    this.assertNotDeleted(sessionId);

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

    // The imported files enter the context immediately before the turn runs.
    if (files.length > 0) {
      await this.ports.ledger.append(sessionId, { type: 'files', turn: turnNumber, source: 'user', files });
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

  async readMedia(sessionId: string, path: string): Promise<{ path: string; mime: string; dataUrl?: string }> {
    this.assertOpen();
    await this.ready;
    const events = this.ports.ledger.read(sessionId);
    if (findCreated(events) === undefined) throw new Error(`Unknown session: ${sessionId}`);
    assertCurrentFormat(events, sessionId);
    // Exact canonical path only; the ledger's own file rows are authoritative.
    const file = collectSessionFiles(events).find((candidate) => candidate.path === path);
    if (!file) throw new Error(`Unknown session file: ${path}`);
    if (!this.isOwnedSessionFile(sessionId, file.path, events)) {
      throw new Error(`Path is outside this session's files: ${path}`);
    }
    if (file.kind !== 'image') return { path: file.path, mime: file.mime };
    const image = await this.ports.fileStore.readImage(file);
    return { path: file.path, mime: file.mime, dataUrl: image.dataUrl };
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.assertOpen();
    await this.ready;
    const prefix = `${sessionId}:`;
    if ([...this.recoveringTurns].some((key) => key.startsWith(prefix))) {
      throw new Error(`Cannot delete a session with a recovering turn: ${sessionId}`);
    }
    if ((this.pendingAdmissions.get(sessionId) ?? 0) > 0) {
      throw new Error(`Cannot delete a session while an attachment import is pending: ${sessionId}`);
    }
    const runtime = this.sessions.get(sessionId);
    if (runtime) {
      for (const turn of runtime.turns.values()) {
        // A durable terminal alone is not enough: a turn can still be parsing
        // blocks, running actions, or holding late results to flush.
        const lateWork = turn.parsePromises.size > 0
          || turn.actionPromises.size > 0
          || turn.resultQueue.length > 0;
        if (!turn.durableTerminal || lateWork) {
          throw new Error(`Cannot delete a session with a running turn: ${sessionId}`);
        }
      }
    }
    const events = this.ports.ledger.read(sessionId);
    if (events.length === 0 && !runtime) throw new Error(`Unknown session: ${sessionId}`);

    // Mark synchronously, before any await, so a send that already passed its
    // admission check cannot append a turn after the timeline is removed.
    this.deletedSessions.add(sessionId);

    const taskRunIds = new Set<string>();
    for (const event of events) {
      if (event.type === 'action.started' && event.taskRunId !== undefined) taskRunIds.add(event.taskRunId);
    }
    for (const turn of runtime?.turns.values() ?? []) {
      for (const taskRunId of turn.taskRunIds) taskRunIds.add(taskRunId);
    }

    try {
      // Remove only the bounded session files directory and each recorded run's
      // bounded artifact directory. Never a checkout or an arbitrary path.
      assertStorageSegment(sessionId);
      await rm(join(this.host.stateRoot, 'sessions', sessionId), { recursive: true, force: true });
      for (const taskRunId of taskRunIds) {
        assertStorageSegment(taskRunId);
        await rm(join(this.host.stateRoot, 'artifacts', taskRunId), { recursive: true, force: true });
      }
      await this.ports.ledger.deleteSession(sessionId);
    } catch (error) {
      // The session survived a failed deletion; allow it to be used again.
      this.deletedSessions.delete(sessionId);
      throw error;
    }
    this.sessions.delete(sessionId);
    this.ensuring.delete(sessionId);
    this.live.drop(sessionId);
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
    // Queued and in-flight replies check this turn's terminal flag before
    // writing. Do not wait for communication belonging to other live turns.
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

  hasRunningTurns(): boolean {
    return this.activeTurnCount() > 0;
  }

  readLedger(sessionId: string): LedgerEvent[] {
    return this.ports.ledger.read(sessionId);
  }

  async inspectContext(request: ContextInspectRequest): Promise<ContextInspection> {
    this.assertOpen();
    return this.inspector.inspect(request);
  }

  readLive(sessionId: string): LiveCall[] {
    return this.live.read(sessionId);
  }

  subscribe(sessionId: string, listener: (event: LedgerEvent) => void): () => void {
    return this.ports.ledger.subscribe(sessionId, listener);
  }

  subscribeLive(sessionId: string, listener: (live: LiveCall[]) => void): () => void {
    return this.live.subscribe(sessionId, listener);
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
    this.live.clear();
    await this.ports.ledger.close();
  }

  // ── session lifecycle ───────────────────────────────────────────────────

  private registerSession(sessionId: string, workspaceRoot: string, snapshot: WorkspaceSnapshot): SessionRuntime {
    // Never resurrect a deleted session from a late recovery.
    this.assertNotDeleted(sessionId);
    const files = this.ports.files(snapshot, workspaceRoot);
    const calls = this.live.wrap(sessionId, this.ports.calls(sessionId));
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
        fileStore: this.ports.fileStore,
        now: () => this.now(),
      }),
      calls,
      callSeq: 0,
      reasonQueue: Promise.resolve(),
      replyQueue: Promise.resolve(),
      title: '新会话',
      lastTitleVersion: 0,
      titleVersion: 0,
      titleUpdatedWithReply: false,
      turns: new Map(),
      nextTurn: 1,
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
    const created = findCreated(events);
    if (!created) throw new Error(`unknown session: ${sessionId}`);
    assertCurrentFormat(events, sessionId);
    const session = this.registerSession(sessionId, created.workspaceRoot, created.snapshot);
    this.replay(session, events);
    await this.recover(session, events);
    return session;
  }

  /** Rebuild cheap derived state (title, next turn) from the ledger. */
  private replay(session: SessionRuntime, events: LedgerEvent[]): void {
    let nextTurn = 1;
    for (const event of events) {
      if (typeof event.turn === 'number' && event.turn >= nextTurn) nextTurn = event.turn + 1;
      switch (event.type) {
        case 'title':
          session.title = event.text;
          session.lastTitleVersion += 1;
          session.titleVersion = session.lastTitleVersion;
          break;
        case 'turn.started':
          if (session.firstUserText === undefined) session.firstUserText = event.text;
          break;
        case 'reply':
          session.titleUpdatedWithReply = true;
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
      if (event.type === 'action.started' && event.taskRunId !== undefined) {
        liveTaskRuns.set(event.turn, [...(liveTaskRuns.get(event.turn) ?? []), event.taskRunId]);
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
    model: { provider: string; model: string; reasoningEffort: ReasoningEffort },
    publicId: string,
    contextWindow: number | undefined,
  ): TurnRuntime {
    return {
      turn,
      userText,
      model,
      publicId,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      imageUnsupported: false,
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
      toolCallsThisCycle: 0,
      asksThisCycle: [],
      actionSeq: 0,
      parsePromises: new Set(),
      actionPromises: new Set(),
      cycleText: '',
      taskRunIds: new Set(),
      correctionRequired: false,
      emptyReasonRetried: false,
      currentReasonText: '',
    };
  }

  private async runTurn(session: SessionRuntime, turn: TurnRuntime): Promise<void> {
    try {
      for (let cycle = 1; ; cycle += 1) {
        if (turn.finished || turn.abort.signal.aborted) return;
        turn.cycle = cycle;
        turn.actionsThisCycle = 0;
        turn.toolCallsThisCycle = 0;
        turn.asksThisCycle = [];
        turn.actionSeq = 0;
        turn.reasonCompleted = false;
        turn.correctionRequired = false;
        turn.cycleText = '';
        turn.currentReasonText = '';

        if (turn.turn === 1 && cycle === 1) this.replies.startInitialTitle(session, turn);

        // One memory-search call precedes every reason request, including the first.
        turn.phase = 'preparing';
        await this.runMemorySearch(session, turn, cycle);
        if (turn.finished) return;

        turn.phase = 'reasoning';
        const reasoned = await this.queueReason(session, () => this.runReason(session, turn, cycle));
        if (turn.finished) return;
        if (!reasoned.ok) {
          // A failed reason call leaves no fresh output: one closing message
          // ends the turn.
          await this.replies.close(session, turn, reasoned.error);
          return;
        }
        // A cycle whose single communication invocation was classified as
        // terminal already ends the turn; that invocation finalizes it, so no
        // second finish call is made here.
        if (reasoned.terminal) return;

        turn.phase = 'acting';
        await this.awaitCycleActions(turn);
        if (turn.finished) return;

        const asks = turn.asksThisCycle;
        const actionRan = turn.actionsThisCycle > 0;

        // More than one question in one cycle is invalid: no action runs and the
        // cycle is corrected.
        if (asks.length > 1) {
          await this.appendError(session.sessionId, 'reason', 'only one ask is allowed per output', turn, cycle);
          turn.correctionRequired = true;
          continue;
        }

        // A question may only be sent alone; when actions ran in the same cycle
        // the question is ignored and the actions stand.
        if (asks.length === 1 && actionRan) {
          await this.appendError(session.sessionId, 'reason', 'ask must be sent alone; it was ignored', turn, cycle);
          continue;
        }

        if (turn.toolCallsThisCycle === 0) {
          // A successful reason call with no tool call and no visible text gave
          // the turn nothing to act on and triggered no communication. The error
          // goes back to the model for one correction cycle; a second empty
          // output in the same turn fails it with a closing message.
          if (turn.currentReasonText.trim() === '') {
            const reason = 'reason call returned no visible output';
            await this.appendError(session.sessionId, 'reason', reason, turn, cycle);
            if (turn.emptyReasonRetried) {
              await this.replies.close(session, turn, reason);
              return;
            }
            turn.emptyReasonRetried = true;
            continue;
          }

          // Hand-written action markup is no longer a delivery channel; actions
          // must be started through the wy_action tool. The cycle's one running
          // communication was already triggered.
          if (hasHandwrittenAction(turn.currentReasonText)) {
            await this.appendError(session.sessionId, 'reason', 'actions can only be started through the wy_action tool', turn, cycle);
            turn.correctionRequired = true;
            continue;
          }
        }

        // Tool calls are present, or a correction was requested: the next cycle
        // continues the turn. The cycle's one running communication was already
        // triggered without waiting for its action executions.
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
        await this.replies.close(session, turn, messageOf(error));
      }
    }
  }

  // ── prepare ─────────────────────────────────────────────────────────────

  /**
   * One memory-search call before every reason request. It selects at most
   * three root memory files from the frozen index and publishes each changed
   * one as a `memory.recalled` event with source `memory-search`. A failed or
   * invalid call is reported and the reason request still runs.
   */
  private async runMemorySearch(session: SessionRuntime, turn: TurnRuntime, cycle: number): Promise<void> {
    const events = this.ports.ledger.read(session.sessionId);
    const view: BuiltView = this.ports.views.memorySearch({
      memoryIndex: session.snapshot.memoryIndex,
      loadedPaths: memoryPathsInContext(events),
      userText: turn.userText,
      lastReasonText: latestReasonText(events),
      actionResults: turnActionResults(turn, events),
    });
    const outcome = await this.invoke(session, turn, 'memory-search', view);
    if (!outcome.ok) {
      await this.appendError(session.sessionId, 'memory-search', outcome.error ?? 'memory-search call failed', turn);
      return;
    }
    const parsed = parseMemoryPicks(outcome.text, session.snapshot.memoryIndex);
    if (!parsed.ok) {
      await this.appendError(session.sessionId, 'memory-search', parsed.reason, turn);
      return;
    }
    for (const pick of parsed.picks) {
      if (turn.finished || turn.abort.signal.aborted) return;
      const file = session.files.read(pick.path);
      if (!file) continue;
      const version = contentVersion(file.content);
      if (latestMemoryVersion(events, pick.path) === version) continue;
      await this.ports.ledger.append(session.sessionId, {
        type: 'memory.recalled',
        turn: turn.turn,
        cycle,
        path: pick.path,
        content: file.content,
        version,
        source: 'memory-search',
      });
    }
  }

  // ── reason ──────────────────────────────────────────────────────────────

  /** Run `task` after every earlier reasoning request of this session has settled. */
  private async queueReason<T>(session: SessionRuntime, task: () => Promise<T>): Promise<T> {
    const previous = session.reasonQueue;
    let release!: () => void;
    session.reasonQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  private async runReason(
    session: SessionRuntime,
    turn: TurnRuntime,
    cycle: number,
  ): Promise<{ ok: true; terminal: boolean } | { ok: false; error: string }> {
    const metadata = resolveModelMetadata(turn.publicId);
    const allowImages = metadata.imageInput === true;
    // The cycle marker is appended before the request is assembled: it renders
    // as this cycle's `<wy-info>` line, so the request only ever grows at its end.
    const previous = this.ports.ledger.read(session.sessionId);
    const lastInputTokens = lastReasonInputTokens(previous);
    await this.ports.ledger.append(session.sessionId, {
      type: 'cycle.started',
      turn: turn.turn,
      cycle,
      model: turn.publicId,
      ...(turn.contextWindow === undefined ? {} : { contextWindow: turn.contextWindow }),
      ...(lastInputTokens === undefined ? {} : { lastInputTokens }),
    });
    const events = this.ports.ledger.read(session.sessionId);

    // Images enter at their native `files` event position and stay in the
    // context. A model that cannot see images disables them for this turn.
    if (!allowImages && contextImageFiles(events).size > 0) turn.imageUnsupported = true;
    const images: Record<string, { dataUrl: string; mime: string }> = allowImages
      ? await this.collectReasonImages(session, events)
      : {};

    const maxTokens = metadata.maxOutputTokens;
    const view = this.ports.views.reason({
      deviceName: this.host.deviceName,
      snapshot: session.snapshot,
      events,
      userText: turn.userText,
      session: this.sessionInfo(session, turn),
      images,
      allowImages,
    });

    // The reason call declares the wy_action tool; completed calls are started
    // as they arrive, while the visible text keeps streaming to the UI. Their
    // raw intents/questions are captured in order for the worker output.
    turn.cycleText = '';
    const workerLines: string[] = [];
    const outcome = await this.invoke(session, turn, 'reason', view, {
      reason: {
        provider: turn.model.provider,
        model: turn.model.model,
        reasoningEffort: turn.model.reasoningEffort,
      },
      ...(maxTokens === undefined ? {} : { maxTokens }),
      onText: (delta) => {
        turn.cycleText += delta;
      },
      onToolCall: (call) => {
        if (turn.finished || turn.abort.signal.aborted) return;
        const promise = this.handleToolCall(session, turn, cycle, call, workerLines)
          .catch((error) => this.appendError(session.sessionId, 'action', messageOf(error), turn));
        turn.parsePromises.add(promise);
        void promise.then(
          () => turn.parsePromises.delete(promise),
          () => turn.parsePromises.delete(promise),
        );
        this.track(promise);
      },
    });

    // The reasoning trace is a context event; it is persisted before the visible
    // message both on success and as the returned partial text on failure.
    if (outcome.reasoning !== undefined && outcome.reasoning !== '') {
      await this.ports.ledger.append(session.sessionId, {
        type: 'thinking',
        turn: turn.turn,
        cycle,
        callId: outcome.callId,
        text: outcome.reasoning,
      });
    }

    if (turn.finished) return { ok: false, error: 'interrupted' };

    if (!outcome.ok) {
      // Failed reasoning must not leave half-started work running. Cancel what
      // is in flight; late results are still recorded, but the reads it queued
      // are not published to the context.
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

    // Reasoning succeeded; its message content is the visible text. Wait for
    // every tool call to be parsed (its intent or question is captured in order)
    // before persisting, so the worker output is complete; executions keep
    // running and are awaited before the next cycle.
    turn.currentReasonText = outcome.text;
    await this.awaitParses(turn);
    if (turn.finished) return { ok: false, error: 'interrupted' };

    const workerOutput = buildWorkerOutput(outcome.text, workerLines);
    const terminal = this.isTerminalCycle(turn, outcome.text);
    await this.ports.ledger.append(session.sessionId, {
      type: 'reason.completed',
      turn: turn.turn,
      cycle,
      callId: outcome.callId,
      text: outcome.text,
      workerOutput,
    });
    turn.reasonCompleted = true;
    await this.flushResults(session, turn);

    // Exactly one communication invocation per nonempty output, immediately
    // after persisting — the action executions are deliberately not awaited. A
    // terminal cycle reuses this same invocation to end the turn.
    if (workerOutput.trim() !== '') {
      this.replies.request(session, turn, {
        cycle,
        status: terminal ? 'completed' : 'running',
        terminal,
      });
    }
    return { ok: true, terminal };
  }

  /**
   * True when a successful reason cycle ends the turn: ordinary visible text
   * with no tool call, or a single question sent alone. A correction, any
   * executed action, or extra questions keep the turn running.
   */
  private isTerminalCycle(turn: TurnRuntime, prose: string): boolean {
    if (turn.correctionRequired) return false;
    const hasActions = turn.actionsThisCycle > 0;
    if (turn.asksThisCycle.length === 1 && !hasActions) return true;
    return turn.toolCallsThisCycle === 0 && prose.trim() !== '' && !hasHandwrittenAction(prose);
  }

  /** Reserve the next call id for one turn. */
  private nextCallId(session: SessionRuntime, turn: TurnRuntime): string {
    return `c${turn.turn}.${++session.callSeq}`;
  }

  /**
   * Read the prepared preview for every image occurrence at its native
   * timeline position. Only the local disk read is de-duplicated by processed
   * path, so two occurrences of the same preview share one payload without
   * dropping either row.
   */
  private async collectReasonImages(
    session: SessionRuntime,
    events: readonly LedgerEvent[],
  ): Promise<Record<string, { dataUrl: string; mime: string }>> {
    const images: Record<string, { dataUrl: string; mime: string }> = {};
    for (const event of events) {
      if (event.type !== 'files') continue;
      for (const file of event.files) {
        if (file.kind !== 'image' || file.processedPath === undefined) continue;
        if (images[file.processedPath] !== undefined) continue;
        try {
          const image = await this.ports.fileStore.readImage(file);
          images[file.processedPath] = { dataUrl: image.dataUrl, mime: image.mime };
        } catch {
          // An unreadable preview is omitted; its metadata row still renders.
        }
      }
    }
    return images;
  }

  private async cancelRunningWork(turn: TurnRuntime): Promise<void> {
    await Promise.allSettled([...turn.taskRunIds].map((id) => this.safeCancelTask(id)));
  }

  /**
   * Apply one completed wy_action tool call: an invalid call forces a
   * correction, a question is remembered for the cycle decision, and a valid
   * action starts executing immediately. Each valid call appends its raw intent
   * or question to the cycle's ordered worker output.
   */
  private async handleToolCall(
    session: SessionRuntime,
    turn: TurnRuntime,
    cycle: number,
    call: ToolCall,
    workerLines: string[],
  ): Promise<void> {
    turn.toolCallsThisCycle += 1;
    const parsed = actionFromToolCall(call);
    if (!parsed.ok) {
      turn.correctionRequired = true;
      await this.appendError(session.sessionId, 'reason', `invalid action call: ${parsed.reason}`, turn, cycle);
      return;
    }
    if ('ask' in parsed) {
      turn.asksThisCycle.push(parsed.ask);
      workerLines.push(`- ask: ${parsed.ask}`);
      return;
    }
    workerLines.push(`- ${parsed.action.kind}: ${parsed.action.intent}`);
    await this.startAction(session, turn, cycle, parsed.action);
  }

  /** Start one parsed action, exactly as a valid block once did. */
  private async startAction(
    session: SessionRuntime,
    turn: TurnRuntime,
    cycle: number,
    action: ParsedAction,
  ): Promise<void> {
    turn.actionsThisCycle += 1;
    const actionId = `a${turn.turn}-${cycle}-${++turn.actionSeq}`;

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
      kind: action.kind,
      parsed: action,
    });

    const executeContext: ActionRunContext = {
      ...this.actionBaseContext(session, turn),
      actionId,
      onTaskRun: (taskRunId: string) =>
        this.recordTaskRun(session, turn, cycle, actionId, action, runtimeAction, taskRunId),
      onTitle: (title: string) => this.recordActionTitle(session, turn, cycle, actionId, title),
    };
    const promise = this.runAction(session, turn, action, executeContext, actionId, cycle);
    turn.actionPromises.add(promise);
    void promise.then(
      () => turn.actionPromises.delete(promise),
      () => turn.actionPromises.delete(promise),
    );
    this.track(promise);
  }

  /**
   * Record a dispatch's task run: a second `action.started` with the same
   * id/parsed plus `taskRunId`, so a restart can find and cancel it.
   */
  private async recordTaskRun(
    session: SessionRuntime,
    turn: TurnRuntime,
    cycle: number,
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
      kind: action.kind,
      parsed: action,
      taskRunId,
    });
    if (turn.abort.signal.aborted) await this.safeCancelTask(taskRunId);
  }

  /** Publish a model-named title for one running action. */
  private recordActionTitle(
    session: SessionRuntime,
    turn: TurnRuntime,
    cycle: number,
    actionId: string,
    title: string,
  ): void {
    const promise = this.appendActionTitle(session, turn, cycle, actionId, title);
    this.track(promise);
  }

  private async appendActionTitle(
    session: SessionRuntime,
    turn: TurnRuntime,
    cycle: number,
    actionId: string,
    title: string,
  ): Promise<void> {
    try {
      await this.ports.ledger.append(session.sessionId, {
        type: 'action.titled',
        turn: turn.turn,
        cycle,
        actionId,
        title,
      });
    } catch {
      // Title reporting must never take the pipeline down.
    }
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
        ...(outcome.task === undefined ? {} : { task: outcome.task }),
        ...(outcome.taskStatus === undefined ? {} : { taskStatus: outcome.taskStatus }),
        ...(outcome.taskRunId === undefined ? {} : { taskRunId: outcome.taskRunId }),
        ...(turn.abort.signal.aborted ? { afterInterrupt: true } : {}),
      },
      outcome.deferred,
    );
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
   * Reads are dropped from a failed/interrupted turn; write-sourced document and
   * workspace facts are always appended.
   */
  private async flushResults(session: SessionRuntime, turn: TurnRuntime): Promise<void> {
    const work = turn.flushPromise.then(async () => {
      while (turn.reasonCompleted && turn.resultQueue.length > 0) {
        const bundle = turn.resultQueue.shift()!;
        const finished = bundle.finished.type === 'action.finished' && (turn.dropDeferred || turn.abort.signal.aborted)
          ? { ...bundle.finished, afterInterrupt: true } : bundle.finished;
        await this.ports.ledger.append(session.sessionId, finished);
        for (const draft of bundle.deferred) {
          const writeInstructions = finished.type === 'action.finished' && finished.kind === 'write'
            && draft.type === 'doc.content' && draft.source === 'project-instructions';
          if (!writeInstructions && isReadDraft(draft) && (turn.dropDeferred || turn.abort.signal.aborted)) continue;
          // Parallel reads snapshot the timeline before any of them lands, so the
          // same document version can be queued more than once; append it once.
          if (draft.type === 'doc.content' && this.ports.ledger.read(session.sessionId).some((event) =>
            event.type === 'doc.content' && event.path === draft.path && event.version === draft.version)) continue;
          await this.ports.ledger.append(session.sessionId, draft);
        }
      }
    });
    turn.flushPromise = work.catch(() => undefined);
    await work;
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private sessionInfo(session: SessionRuntime, turn: TurnRuntime): SessionViewInfo {
    return {
      now: this.now().toISOString(),
      sessionId: session.sessionId,
      turn: turn.turn,
      cycle: turn.cycle,
      model: turn.publicId,
      deviceName: this.host.deviceName,
      ...(turn.contextWindow === undefined ? {} : { contextWindow: turn.contextWindow }),
    };
  }

  private actionBaseContext(session: SessionRuntime, turn: TurnRuntime): ActionBaseContext {
    const snapshot = session.snapshot;
    const tasks = [
      ...snapshot.projects.flatMap((project) =>
        project.tasks.map((task) => ({
          id: task.id,
          project: project.id,
          description: task.description,
          inputSummary: task.inputSummary,
        })),
      ),
      ...snapshot.builtinTasks.map((task) => ({
        id: task.id,
        description: task.description,
        inputSummary: task.inputSummary,
      })),
    ];
    return {
      sessionId: session.sessionId,
      turn: turn.turn,
      cycle: turn.cycle,
      userText: turn.userText,
      workspaceRoot: session.workspaceRoot,
      snapshot,
      currentEvents: () => this.ports.ledger.read(session.sessionId),
      projects: snapshot.projects.map((project) => ({
        id: project.id,
        ...(project.displayName === undefined ? {} : { displayName: project.displayName }),
        workspaceDir: project.workspaceDir,
        ...(project.checkoutPath === undefined ? {} : { checkoutPath: project.checkoutPath }),
      })),
      tasks,
      signal: turn.abort.signal,
    };
  }

  private isOwnedSessionFile(sessionId: string, path: string, events: readonly LedgerEvent[]): boolean {
    if (isInside(path, join(this.host.stateRoot, 'sessions', sessionId, 'files'))) return true;
    const runIds = new Set<string>();
    for (const event of events) {
      if ((event.type === 'action.started' || event.type === 'files') && event.taskRunId !== undefined) {
        runIds.add(event.taskRunId);
      }
    }
    for (const runId of runIds) {
      if (isInside(path, join(this.host.stateRoot, 'artifacts', runId))) return true;
    }
    return false;
  }

  async appendError(
    sessionId: string,
    stage: string,
    message: string,
    turn: TurnRuntime,
    cycle?: number,
  ): Promise<void> {
    try {
      await this.ports.ledger.append(sessionId, {
        type: 'error',
        stage,
        message,
        ...(turn.turn > 0 ? { turn: turn.turn, cycle: cycle ?? turn.cycle } : {}),
      });
    } catch {
      // Error reporting must never take the pipeline down.
    }
  }

  /**
   * Run one model call. `calls.ts` writes the `call` event and throws on
   * failure, so every role's failure consequence is decided here.
   */
  async invoke(
    session: SessionRuntime,
    turn: TurnRuntime,
    role: CallRole,
    view: BuiltView,
    extra: {
      callId?: string;
      reason?: { provider: string; model: string; reasoningEffort: ReasoningEffort };
      onText?: (delta: string) => void;
      onReasoning?: (delta: string) => void;
      onToolCall?: (call: ToolCall) => void;
      maxTokens?: number;
      cycle?: number;
    } = {},
  ): Promise<{ ok: boolean; callId: string; text: string; reasoning?: string; error?: string }> {
    const callId = extra.callId ?? this.nextCallId(session, turn);
    try {
      const result = await session.calls.run({
        callId,
        role,
        turn: turn.turn,
        cycle: extra.cycle ?? turn.cycle,
        messages: view.messages,
        layers: view.layers,
        signal: turn.abort.signal,
        ...(extra.reason === undefined ? {} : { reason: extra.reason }),
        ...(extra.onText === undefined ? {} : { onText: extra.onText }),
        ...(extra.onReasoning === undefined ? {} : { onReasoning: extra.onReasoning }),
        ...(extra.onToolCall === undefined ? {} : { onToolCall: extra.onToolCall }),
        ...(extra.maxTokens === undefined ? {} : { maxTokens: extra.maxTokens }),
      });
      return {
        ok: true,
        callId,
        text: result.text,
        ...(result.reasoning === undefined ? {} : { reasoning: result.reasoning }),
      };
    } catch (error) {
      const reasoning = error instanceof ModelCallError ? error.detail.partialReasoning : undefined;
      return {
        ok: false,
        callId,
        text: '',
        error: messageOf(error),
        ...(reasoning === undefined ? {} : { reasoning }),
      };
    }
  }

  private async safeCancelTask(taskRunId: string): Promise<void> {
    try {
      await this.host.cancelTaskRun(taskRunId);
    } catch {
      // Cancellation is best-effort; a stale run id must not fail the turn.
    }
  }

  // ── live streaming snapshots ────────────────────────────────────────────

  track(promise: Promise<unknown>): void {
    this.pipeline.add(promise);
    void promise
      .catch(() => undefined)
      .finally(() => this.pipeline.delete(promise));
  }

  now(): Date {
    return this.host.now ? this.host.now() : new Date();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('session is closed');
  }

  private assertNotDeleted(sessionId: string): void {
    if (this.deletedSessions.has(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
  }

  /** Count one in-flight attachment import for the session. */
  private beginAdmission(sessionId: string): void {
    this.pendingAdmissions.set(sessionId, (this.pendingAdmissions.get(sessionId) ?? 0) + 1);
  }

  /** Release one admission; the entry is dropped only when the last one ends. */
  private endAdmission(sessionId: string): void {
    const remaining = (this.pendingAdmissions.get(sessionId) ?? 1) - 1;
    if (remaining <= 0) this.pendingAdmissions.delete(sessionId);
    else this.pendingAdmissions.set(sessionId, remaining);
  }
}

// ─── shared helpers ────────────────────────────────────────────────────────

/** First `session.created` event, using a real type guard. */
function findCreated(events: readonly LedgerEvent[]): SessionCreatedEvent | undefined {
  for (const event of events) if (event.type === 'session.created') return event;
  return undefined;
}

/** Reject any session whose timeline is not the current on-disk format. */
function assertCurrentFormat(events: readonly LedgerEvent[], sessionId: string): void {
  const created = findCreated(events);
  if (!created) throw new Error(`unknown session: ${sessionId}`);
  if (created.format !== CURRENT_SESSION_FORMAT) throw new Error(OLD_SESSION_FORMAT_ERROR);
}

/** Guard one storage directory segment (session id / task run id). */
function assertStorageSegment(value: string): void {
  if (value === '.' || value === '..' || value === '' || /[/\\\u0000]/u.test(value)) {
    throw new Error(`invalid storage segment: ${value}`);
  }
}

/** Simple lexical containment: `child` is `root` or a path below it. */
function isInside(child: string, root: string): boolean {
  if (child === root) return true;
  const rel = relative(root, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Distinct memory paths already recalled into the context, in timeline order. */
function memoryPathsInContext(events: readonly LedgerEvent[]): string[] {
  const paths: string[] = [];
  for (const event of events) {
    if (event.type === 'memory.recalled' && !paths.includes(event.path)) paths.push(event.path);
  }
  return paths;
}

/** The latest visible reasoning output on the timeline. */
/** Upstream-reported input tokens of the most recent finished reasoning call. */
function lastReasonInputTokens(events: readonly LedgerEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'call' && event.role === 'reason') return event.usage?.input;
  }
  return undefined;
}

/** The content version of the latest memory recall for one path. */
function latestMemoryVersion(events: readonly LedgerEvent[], path: string): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'memory.recalled' && event.path === path) return event.version;
  }
  return undefined;
}

/** This turn's committed action results, trimmed for the memory-search view. */
function turnActionResults(
  turn: TurnRuntime,
  events: readonly LedgerEvent[],
): { name: string; status: string; text: string }[] {
  const results: { name: string; status: string; text: string }[] = [];
  for (const event of events) {
    if (event.type !== 'action.finished' || event.turn !== turn.turn) continue;
    results.push({ name: event.kind, status: event.status, text: event.result.slice(0, ACTION_RESULT_EXCERPT) });
  }
  return results;
}

/** A draft whose body is a read (dropped from a failed/interrupted turn). */
function isReadDraft(draft: LedgerEventDraft): boolean {
  switch (draft.type) {
    case 'doc.content':
      return draft.source === 'read' || draft.source === 'project-instructions';
    case 'files':
      return draft.source === 'read';
    case 'memory.recalled':
      return true;
    default:
      return false;
  }
}

/**
 * Exact canonical root memory paths actually listed in the frozen raw index.
 * Only inline Markdown link targets and standalone canonical path entries are
 * considered, so a name that merely appears in a link label or prose never
 * admits a path. Root `name.md` / `./name.md` targets normalize relative to
 * `memories/INDEX.md` to `memories/name.md`. Parent traversal, nested folders,
 * absolute/external targets and INDEX.md are excluded.
 */
function canonicalMemoryTargets(memoryIndex: string): Set<string> {
  const targets = new Set<string>();
  const candidates: string[] = [];
  // Actual inline Markdown link targets: `[label](target)`.
  const link = /\[[^\]\n]*\]\(\s*<?([^()<>\s]+)>?\s*\)/gu;
  for (let match = link.exec(memoryIndex); match !== null; match = link.exec(memoryIndex)) {
    candidates.push(match[1]!);
  }
  // Standalone canonical path list entries such as `- memories/m1.md`.
  const entry = /^[ \t]*(?:[-*+]|\d+[.)])?[ \t]*(memories\/[^/ \t()[\]<>]+\.md)[ \t]*$/gmu;
  for (let match = entry.exec(memoryIndex); match !== null; match = entry.exec(memoryIndex)) {
    candidates.push(match[1]!);
  }
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed === '' || trimmed.startsWith('/') || trimmed.includes('://')) continue;
    const segments = trimmed.replace(/^\.\//u, '').split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) continue;
    let canonical: string | undefined;
    if (segments.length === 1 && segments[0]!.endsWith('.md')) canonical = `memories/${segments[0]!}`;
    else if (segments.length === 2 && segments[0] === 'memories' && segments[1]!.endsWith('.md')) canonical = `memories/${segments[1]!}`;
    if (canonical === undefined || !/^memories\/[^/]+\.md$/u.test(canonical)) continue;
    if (canonical.toLowerCase() === 'memories/index.md') continue;
    targets.add(canonical);
  }
  return targets;
}

/**
 * Validate the memory selector's strict JSON: at most three `{ path, reason }`
 * picks, each an existing root `memories/*.md` file listed in the frozen index.
 * A malformed result is reported, never repaired.
 */
function parseMemoryPicks(
  text: string,
  memoryIndex: string,
): { ok: true; picks: { path: string; reason: string }[] } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch (error) {
    return { ok: false, reason: `memory-search output is not valid JSON: ${messageOf(error)}` };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'memory-search output must be a JSON object' };
  }
  const picks = (value as { picks?: unknown }).picks;
  if (!Array.isArray(picks)) return { ok: false, reason: 'memory-search output must contain a picks array' };
  const indexedTargets = canonicalMemoryTargets(memoryIndex);
  const result: { path: string; reason: string }[] = [];
  for (const raw of picks) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reason: 'memory-search pick must be an object' };
    }
    const path = (raw as { path?: unknown }).path;
    const reason = (raw as { reason?: unknown }).reason;
    if (typeof path !== 'string' || path.trim() === '') {
      return { ok: false, reason: 'memory-search pick needs a non-empty path' };
    }
    if (typeof reason !== 'string') return { ok: false, reason: 'memory-search pick needs a reason string' };
    if (!/^memories\/[^/]+\.md$/u.test(path) || path.toLowerCase() === 'memories/index.md') {
      return { ok: false, reason: `memory-search path is not a root memory file: ${path}` };
    }
    if (!indexedTargets.has(path)) {
      return { ok: false, reason: `memory-search path is not in the memory index: ${path}` };
    }
    if (!result.some((pick) => pick.path === path)) result.push({ path, reason });
    if (result.length >= 3) break;
  }
  return { ok: true, picks: result };
}

/** Intent-only description of one typed action, for the running-action table. */
function describeAction(action: ParsedAction): string {
  return `${action.kind}: ${oneLine(action.intent)}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The complete worker output of one reason cycle: the visible prose followed by
 * the raw action intents and questions of its wy_action calls, in order. The
 * prose itself is never altered, so the event's `text` stays the main reasoning
 * rendering while `workerOutput` feeds the communication view.
 */
function buildWorkerOutput(prose: string, lines: readonly string[]): string {
  if (lines.length === 0) return prose;
  const block = lines.join('\n');
  return prose.trim() === '' ? block : `${prose}\n${block}`;
}

/** True when visible text pretends to start an action with hand-written markup. */
function hasHandwrittenAction(text: string): boolean {
  return text.includes('<action') || text.includes('<wy-action');
}
