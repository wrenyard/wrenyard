/**
 * session turn loop: the work-turn state machine and the cycle loop over the
 * session runtime. `engine.ts` owns the session lifecycle and calls into this
 * runner for everything a turn does.
 */

import {
  contextImageFiles,
  type LedgerEvent,
  type LedgerEventDraft,
} from './ledger.ts';
import { resolveModelMetadata } from './calls.ts';
import { type ToolCall } from './driver.ts';
import { ACTION_TOOL, parseActionCall } from './actions/reason/tool.ts';
import { buildReason } from './actions/reason/prompt.ts';
import {
  type ActionExecutionOutcome,
  type ActionKind,
  type ActionRunContext,
  type ParsedAction,
} from './actions/index.ts';
import { runMemorySearch } from './actions/secondary/memory.ts';
import type { ReplyWriter } from './actions/secondary/reply.ts';
import { startInitialTitle } from './actions/secondary/title.ts';
import type { ActionBaseContext, SessionCallHost, SessionViewInfo } from './ports.ts';
import type { RuntimeAction, SessionRuntime, TurnRuntime } from './runtime.ts';
import { messageOf } from './errors.ts';

/** Run the turn and cycle loop over the session runtime. */
export class TurnRunner {
  constructor(
    private readonly engine: SessionCallHost,
    private readonly replies: ReplyWriter,
  ) {}

  async runTurn(session: SessionRuntime, turn: TurnRuntime): Promise<void> {
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

        if (turn.turn === 1 && cycle === 1) startInitialTitle(this.engine, session, turn);

        // One memory-search call precedes every reason request, including the first.
        turn.phase = 'preparing';
        await runMemorySearch(this.engine, session, turn, cycle);
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
          await this.engine.appendError(session.sessionId, 'reason', 'only one ask is allowed per output', turn, cycle);
          turn.correctionRequired = true;
          continue;
        }

        // A question may only be sent alone; when actions ran in the same cycle
        // the question is ignored and the actions stand.
        if (asks.length === 1 && actionRan) {
          await this.engine.appendError(session.sessionId, 'reason', 'ask must be sent alone; it was ignored', turn, cycle);
          continue;
        }

        if (turn.toolCallsThisCycle === 0) {
          // A successful reason call with no tool call and no visible text gave
          // the turn nothing to act on and triggered no communication. The error
          // goes back to the model for one correction cycle; a second empty
          // output in the same turn fails it with a closing message.
          if (turn.currentReasonText.trim() === '') {
            const reason = 'reason call returned no visible output';
            await this.engine.appendError(session.sessionId, 'reason', reason, turn, cycle);
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
            await this.engine.appendError(session.sessionId, 'reason', 'actions can only be started through the wy_action tool', turn, cycle);
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
    const previous = this.engine.ledger.read(session.sessionId);
    const lastInputTokens = lastReasonInputTokens(previous);
    await this.engine.ledger.append(session.sessionId, {
      type: 'cycle.started',
      turn: turn.turn,
      cycle,
      model: turn.publicId,
      ...(turn.contextWindow === undefined ? {} : { contextWindow: turn.contextWindow }),
      ...(lastInputTokens === undefined ? {} : { lastInputTokens }),
    });
    const events = this.engine.ledger.read(session.sessionId);

    // Images enter at their native `files` event position and stay in the
    // context. A model that cannot see images disables them for this turn.
    if (!allowImages && contextImageFiles(events).size > 0) turn.imageUnsupported = true;
    const images: Record<string, { dataUrl: string; mime: string }> = allowImages
      ? await this.collectReasonImages(session, events)
      : {};

    const maxTokens = metadata.maxOutputTokens;
    const view = buildReason({
      deviceName: this.engine.host.deviceName,
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
    const outcome = await this.engine.invoke(session, turn, 'reason', view, {
      reason: {
        provider: turn.model.provider,
        model: turn.model.model,
        reasoningEffort: turn.model.reasoningEffort,
      },
      ...(maxTokens === undefined ? {} : { maxTokens }),
      tools: [ACTION_TOOL],
      onText: (delta) => {
        turn.cycleText += delta;
      },
      onToolCall: (call) => {
        if (turn.finished || turn.abort.signal.aborted) return;
        const promise = this.handleToolCall(session, turn, cycle, call, workerLines)
          .catch((error) => this.engine.appendError(session.sessionId, 'action', messageOf(error), turn));
        turn.parsePromises.add(promise);
        void promise.then(
          () => turn.parsePromises.delete(promise),
          () => turn.parsePromises.delete(promise),
        );
        this.engine.track(promise);
      },
    });

    // The reasoning trace is a context event; it is persisted before the visible
    // message both on success and as the returned partial text on failure.
    if (outcome.reasoning !== undefined && outcome.reasoning !== '') {
      await this.engine.ledger.append(session.sessionId, {
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
    await this.engine.ledger.append(session.sessionId, {
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
          const image = await this.engine.ports.fileStore.readImage(file);
          images[file.processedPath] = { dataUrl: image.dataUrl, mime: image.mime };
        } catch {
          // An unreadable preview is omitted; its metadata row still renders.
        }
      }
    }
    return images;
  }

  private async cancelRunningWork(turn: TurnRuntime): Promise<void> {
    await Promise.allSettled([...turn.taskRunIds].map((id) => this.engine.safeCancelTask(id)));
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
    const parsed = parseActionCall(call);
    if ('error' in parsed) {
      turn.correctionRequired = true;
      await this.engine.appendError(session.sessionId, 'reason', `invalid action call: ${parsed.error}`, turn, cycle);
      return;
    }
    if (parsed.type === 'ask') {
      turn.asksThisCycle.push(parsed.intent);
      workerLines.push(`- ask: ${parsed.intent}`);
      return;
    }
    workerLines.push(`- ${parsed.type}: ${parsed.intent}`);
    await this.startAction(session, turn, cycle, { kind: parsed.type as ActionKind, intent: parsed.intent });
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
      startedAt: this.engine.now().toISOString(),
    };
    turn.actions.set(actionId, runtimeAction);
    await this.engine.ledger.append(session.sessionId, {
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
    this.engine.track(promise);
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
    await this.engine.ledger.append(session.sessionId, {
      type: 'action.started',
      turn: turn.turn,
      cycle,
      actionId,
      kind: action.kind,
      parsed: action,
      taskRunId,
    });
    if (turn.abort.signal.aborted) await this.engine.safeCancelTask(taskRunId);
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
    this.engine.track(promise);
  }

  private async appendActionTitle(
    session: SessionRuntime,
    turn: TurnRuntime,
    cycle: number,
    actionId: string,
    title: string,
  ): Promise<void> {
    try {
      await this.engine.ledger.append(session.sessionId, {
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
  async flushResults(session: SessionRuntime, turn: TurnRuntime): Promise<void> {
    const work = turn.flushPromise.then(async () => {
      while (turn.reasonCompleted && turn.resultQueue.length > 0) {
        const bundle = turn.resultQueue.shift()!;
        const finished = bundle.finished.type === 'action.finished' && (turn.dropDeferred || turn.abort.signal.aborted)
          ? { ...bundle.finished, afterInterrupt: true } : bundle.finished;
        await this.engine.ledger.append(session.sessionId, finished);
        for (const draft of bundle.deferred) {
          if (isReadDraft(draft) && (turn.dropDeferred || turn.abort.signal.aborted)) continue;
          // Parallel reads snapshot the timeline before any of them lands, so the
          // same document version can be queued more than once; append it once.
          if (draft.type === 'doc.content' && this.engine.ledger.read(session.sessionId).some((event) =>
            event.type === 'doc.content' && event.path === draft.path && event.version === draft.version)) continue;
          await this.engine.ledger.append(session.sessionId, draft);
        }
      }
    });
    turn.flushPromise = work.catch(() => undefined);
    await work;
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private sessionInfo(session: SessionRuntime, turn: TurnRuntime): SessionViewInfo {
    return {
      now: this.engine.now().toISOString(),
      sessionId: session.sessionId,
      turn: turn.turn,
      cycle: turn.cycle,
      model: turn.publicId,
      deviceName: this.engine.host.deviceName,
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
      currentEvents: () => this.engine.ledger.read(session.sessionId),
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
}

// ─── top-level helpers ──────────────────────────────────────────────────────

/** Upstream-reported input tokens of the most recent finished reasoning call. */
function lastReasonInputTokens(events: readonly LedgerEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'call' && event.role === 'reason') return event.usage?.input;
  }
  return undefined;
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

/** Intent-only description of one typed action, for the running-action table. */
function describeAction(action: ParsedAction): string {
  return `${action.kind}: ${oneLine(action.intent)}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
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
