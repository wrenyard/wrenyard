/**
 * session turn loop: the work-turn state machine and the step loop over the
 * session runtime. `engine.ts` owns the session lifecycle and calls into this
 * runner for everything a turn does.
 */

import {
  contextImageFiles,
  stepId,
  turnId,
  type LedgerEvent,
  type LedgerEventDraft,
  type StepStatus,
} from '../ledger/store.ts';
import { contextBudgetOf, resolveModelMetadata } from '../model/request.ts';
import { type ToolCall } from '../transport/index.ts';
import { ACTION_TOOL, parseActionCall } from '../reasoning/tool.ts';
import { buildReason } from '../reasoning/prompt.ts';
import { compactContext, renderKernelFactsBlock } from '../context/compaction.ts';
import { computeReduction } from '../context/reduction.ts';
import {
  type ActionExecutionOutcome,
  type ActionRunContext,
  type ParsedAction,
  type ActionType,
} from '../reasoning/actions.ts';
import { runMemorySearch } from '../auxiliary/memory.ts';
import type { ReplyWriter } from '../auxiliary/reply.ts';
import { startInitialTitle } from '../auxiliary/title.ts';
import type { CallFailureSummary, ActionBaseContext, SessionCallHost, SessionViewInfo } from '../ports.ts';
import type { RuntimeAction, SessionRuntime, TurnRuntime } from './runtime.ts';
import { messageOf } from '../errors.ts';

/** Run the turn and step loop over the session runtime. */
export class TurnRunner {
  constructor(
    private readonly engine: SessionCallHost,
    private readonly replies: ReplyWriter,
  ) {}

  async runTurn(session: SessionRuntime, turn: TurnRuntime): Promise<void> {
    try {
      for (let step = 1; ; step += 1) {
        if (turn.finished || turn.abort.signal.aborted) return;
        turn.step = step;
        turn.actionsThisStep = 0;
        turn.toolCallsThisStep = 0;
        turn.asksThisStep = [];
        turn.reasonCompleted = false;
        turn.correctionRequired = false;
        turn.stepText = '';
        turn.currentReasonText = '';
        turn.currentStepId = undefined;

        let stepStatus: StepStatus = 'done';
        try {
          if (turn.turn === 1 && step === 1) startInitialTitle(this.engine, session, turn);

          // One memory-search call precedes every reason request, including the first.
          turn.phase = 'preparing';
          await runMemorySearch(this.engine, session, turn, step);
          if (turn.finished) return;

          turn.phase = 'reasoning';
          const reasoned = await this.queueReason(session, () => this.runReason(session, turn, step));
          if (turn.finished) return;
          if (!reasoned.ok) {
            // A failed reason call leaves no fresh output: one closing message
            // ends the turn, with the structured failure facts when available.
            stepStatus = 'failed';
            await this.replies.close(session, turn, reasoned.error, reasoned.failure);
            return;
          }
          // A step whose single communication invocation was classified as
          // terminal already ends the turn; that invocation finalizes it.
          if (reasoned.terminal) return;

          turn.phase = 'acting';
          await this.awaitStepActions(turn);
          if (turn.finished) return;

          const port = this.engine.host.agentTools?.(session.sessionId);
          if (port !== undefined && turn.portToolCallsThisTurn >= (port.maxToolCalls ?? 24)) {
            await this.flushResults(session, turn);
            stepStatus = 'failed';
            await this.replies.close(session, turn, 'tool call limit reached; turn ended');
            return;
          }

          const asks = turn.asksThisStep;
          const actionRan = turn.actionsThisStep > 0;

          // More than one question in one step is invalid: no action runs and
          // the step is corrected.
          if (asks.length > 1) {
            await this.engine.appendError(session.sessionId, 'reason', 'only one ask is allowed per output', turn, step);
            turn.correctionRequired = true;
            continue;
          }

          // A question may only be sent alone; when actions ran in the same step
          // the question is ignored and the actions stand.
          if (asks.length === 1 && actionRan) {
            await this.engine.appendError(session.sessionId, 'reason', 'ask must be sent alone; it was ignored', turn, step);
            continue;
          }

          if (turn.toolCallsThisStep === 0) {
            // A successful reason call with no tool call and no visible text gave
            // the turn nothing to act on. The error goes back to the model for
            // one correction step; a second empty output fails the turn.
            if (turn.currentReasonText.trim() === '') {
              const reason = 'reason call returned no visible output';
              await this.engine.appendError(session.sessionId, 'reason', reason, turn, step);
              if (turn.emptyReasonRetried) {
                stepStatus = 'failed';
                await this.replies.close(session, turn, reason);
                return;
              }
              turn.emptyReasonRetried = true;
              continue;
            }

            // Hand-written action markup is no longer a delivery channel;
            // actions must be started through the wy_action tool.
            if (hasHandwrittenAction(turn.currentReasonText)) {
              await this.engine.appendError(session.sessionId, 'reason', 'actions can only be started through the wy_action tool', turn, step);
              turn.correctionRequired = true;
              continue;
            }
          }

          // Tool calls are present, or a correction was requested: the next step
          // continues the turn.
        } catch (error) {
          stepStatus = 'failed';
          throw error;
        } finally {
          // A step always gets exactly one step.finished, even when it returns
          // or throws from inside the loop.
          if (turn.finished || turn.abort.signal.aborted) stepStatus = 'interrupted';
          // The system reply is one of the step's actions, and its auxiliary
          // span lands before it; step.finished must follow them, so the step's
          // serialized reply chain is awaited before the closing marker.
          await session.replyQueue;
          await this.finishStep(session, turn, stepStatus);
        }
      }
    } catch (error) {
      if (!turn.finished) {
        turn.dropDeferred = true;
        turn.reasonCompleted = true;
        turn.abort.abort();
        await this.cancelRunningWork(turn);
        await this.awaitParses(turn);
        await this.awaitStepActions(turn);
        await this.flushResults(session, turn);
        if (turn.finished) return;
        turn.abort = new AbortController();
        await this.replies.close(session, turn, messageOf(error));
      }
    }
  }

  /** Append the step's single `step.finished` once, when a `step.started` exists. */
  private async finishStep(session: SessionRuntime, turn: TurnRuntime, status: StepStatus): Promise<void> {
    const id = turn.currentStepId;
    if (id === undefined) return;
    turn.currentStepId = undefined;
    try {
      await this.engine.ledger.append(session.sessionId, {
        type: 'step.finished',
        turn: turn.turn,
        step: turn.step,
        id,
        status,
      });
    } catch {
      // Step bookkeeping must never take the pipeline down.
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
    step: number,
  ): Promise<{ ok: true; terminal: boolean } | { ok: false; error: string; failure?: CallFailureSummary }> {
    const metadata = resolveModelMetadata(turn.publicId, (id) => this.engine.host.resolveInferenceProvider(id));
    const allowImages = metadata.imageInput === true;
    // The step marker is appended before the request is assembled: it renders
    // as this step's `<wy-info>` line, so the request only ever grows at its end.
    const previous = this.engine.ledger.read(session.sessionId);
    const lastInputTokens = lastReasonInputTokens(previous);
    const stepKey = stepId(turn.turn, step);
    await this.engine.ledger.append(session.sessionId, {
      type: 'step.started',
      id: stepKey,
      parent: turnId(turn.turn),
      turn: turn.turn,
      step,
      model: turn.publicId,
      ...(turn.contextWindow === undefined ? {} : { contextWindow: turn.contextWindow }),
      ...(lastInputTokens === undefined ? {} : { lastInputTokens }),
    });
    turn.currentStepId = stepKey;
    const events = this.engine.ledger.read(session.sessionId);

    // Images enter at their native `files.attached` event position and stay in
    // the context. A model that cannot see images disables them for this turn.
    if (!allowImages && contextImageFiles(events).size > 0) turn.imageUnsupported = true;
    const images: Record<string, { dataUrl: string; mime: string }> = allowImages
      ? await this.collectReasonImages(session, events)
      : {};

    const maxTokens = metadata.maxOutputTokens;
    // An agent tool port, when the host provides one for this session, owns the
    // whole system prompt and the native tool set; absent keeps the built-in
    // orchestrator prompt and the single wy_action tool.
    const port = this.engine.host.agentTools?.(session.sessionId);
    const tools = port === undefined ? [ACTION_TOOL] : port.tools;
    const buildView = (currentEvents: LedgerEvent[]) => buildReason({
      deviceName: this.engine.host.deviceName,
      snapshot: session.snapshot,
      events: currentEvents,
      userText: turn.userText,
      session: this.sessionInfo(session, turn),
      images,
      allowImages,
      ...(port === undefined ? {} : { systemOverride: port.system }),
    });
    let view = buildView(events);

    // A request that would cross the compaction threshold is reduced first and
    // summarised only when the reduction left it over the threshold. Both keep
    // every event on the ledger; their floors bound only the rendered view. A
    // rebuilt view that is still over the hard budget falls through to the
    // send-time guard, which refuses it without ever resending the unchanged
    // request.
    const budget = contextBudgetOf(
      turn.publicId,
      view.messages,
      (id) => this.engine.host.resolveInferenceProvider(id),
      maxTokens,
    );
    if (!turn.finished && !turn.abort.signal.aborted
      && budget.threshold !== undefined && budget.estimatedInputTokens > budget.threshold) {
      // Stage 1: release the bulky content of cold, older events. It makes no
      // model call, so it runs before the summary, and the floor it records
      // keeps the rendered prefix stable until the next reduction.
      let source = events;
      let overThreshold = true;
      const reduction = computeReduction(source, budget.threshold);
      if (reduction !== undefined) {
        await this.engine.ledger.append(session.sessionId, {
          type: 'context.reduced',
          turn: turn.turn,
          step,
          throughSeq: reduction.throughSeq,
          ...(reduction.releasedTokens === undefined ? {} : { releasedTokens: reduction.releasedTokens }),
        });
        source = this.engine.ledger.read(session.sessionId);
        view = buildView(source);
        const reduced = contextBudgetOf(
          turn.publicId,
          view.messages,
          (id) => this.engine.host.resolveInferenceProvider(id),
          maxTokens,
        );
        overThreshold = reduced.threshold === undefined
          || reduced.estimatedInputTokens > reduced.threshold;
        if (!overThreshold) {
          const facts = port?.kernelFacts?.();
          if (facts !== undefined && facts.trim() !== '') {
            view.messages.splice(view.messages.length - 1, 0, { role: 'user', content: renderKernelFactsBlock(facts) });
          }
        }
      }
      if (overThreshold) {
        const compacted = await compactContext({
          events: source,
          metadata,
          ...(maxTokens === undefined ? {} : { outputReservation: maxTokens }),
          estimatedInputTokens: budget.estimatedInputTokens,
          title: session.title,
          summarize: async (messages, maxOutputTokens) => {
            const outcome = await this.engine.invoke(session, turn, 'reason', { messages: [...messages], layers: {} }, {
              parent: stepKey,
              step,
              reason: {
                provider: turn.model.provider,
                model: turn.model.model,
                reasoningEffort: turn.model.reasoningEffort,
                fast: turn.model.fast,
              },
              maxTokens: maxOutputTokens,
            });
            return outcome.ok
              ? { ok: true, text: outcome.text }
              : { ok: false, error: outcome.error ?? 'compaction summary call failed' };
          },
        });
        if (compacted.throughSeq > 0) {
          await this.engine.ledger.append(session.sessionId, {
            type: 'context.compacted',
            turn: turn.turn,
            step,
            throughSeq: compacted.throughSeq,
            summary: compacted.summary,
            ...(compacted.estimatedInputTokens === undefined ? {} : { estimatedInputTokens: compacted.estimatedInputTokens }),
            ...(compacted.contextWindow === undefined ? {} : { contextWindow: compacted.contextWindow }),
            ...(compacted.failure === undefined ? {} : { failure: compacted.failure }),
          });
          const kernelFacts = port?.kernelFacts?.();
          const freshEvents = this.engine.ledger.read(session.sessionId);
          view = buildView(freshEvents);
          if (kernelFacts !== undefined && kernelFacts.trim() !== '') {
            view.messages.splice(view.messages.length - 1, 0, { role: 'user', content: renderKernelFactsBlock(kernelFacts) });
          }
          contextBudgetOf(
            turn.publicId,
            view.messages,
            (id) => this.engine.host.resolveInferenceProvider(id),
            maxTokens,
          );
        }
      }
    }

    // The reason call declares the wy_action tool; completed calls are started
    // as they arrive, while the visible text keeps streaming to the UI. Their
    // raw intents/questions are captured in order for the worker output.
    turn.stepText = '';
    const workerLines: string[] = [];
    const outcome = await this.engine.invoke(session, turn, 'reason', view, {
      parent: stepKey,
      reason: {
        provider: turn.model.provider,
        model: turn.model.model,
        reasoningEffort: turn.model.reasoningEffort,
        fast: turn.model.fast,
      },
      ...(maxTokens === undefined ? {} : { maxTokens }),
      // The bounded-recovery wait lifecycle: record the observational waiting
      // events (never model context) and expose/clear the engine's live waiting
      // marker, which gates a repeated continue of the same selected model. A
      // later attempt, completion or cancel appends the matching clear and drops
      // the marker (fenced by turn number).
      onWait: (state) => {
        if (state === null) {
          this.engine.clearRecoveryWait(session.sessionId, turn.turn);
          this.engine.track(this.engine.ledger.append(session.sessionId, {
            type: 'turn.waiting.cleared',
            turn: turn.turn,
            parent: turnId(turn.turn),
          }));
          return;
        }
        this.engine.setRecoveryWait(session.sessionId, {
          turn: turn.turn,
          model: turn.publicId,
          effort: turn.model.reasoningEffort,
          attachmentsKey: turn.attachmentsKey,
        });
        this.engine.track(this.engine.ledger.append(session.sessionId, {
          type: 'turn.waiting',
          turn: turn.turn,
          parent: turnId(turn.turn),
          reason: state.reason,
          retryAt: state.retryAt,
        }));
      },
      ...(tools.length === 0 ? {} : { tools }),
      onText: (delta) => {
        turn.stepText += delta;
      },
      onToolCall: (call) => {
        if (turn.finished || turn.abort.signal.aborted) return;
        const promise = this.handleToolCall(session, turn, step, call, workerLines)
          .catch((error) => this.engine.appendError(session.sessionId, 'action', messageOf(error), turn, step));
        turn.parsePromises.add(promise);
        void promise.then(
          () => turn.parsePromises.delete(promise),
          () => turn.parsePromises.delete(promise),
        );
        this.engine.track(promise);
      },
    });

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
      await this.awaitStepActions(turn);
      await this.flushResults(session, turn);
      if (!turn.finished) turn.abort = new AbortController();
      return { ok: false, error: outcome.error ?? 'reason call failed', ...(outcome.failure === undefined ? {} : { failure: outcome.failure }) };
    }

    // Reasoning succeeded: its trace and message are content events parented by
    // the reasoning span. Nothing is written for a failed request.
    if (outcome.reasoning !== undefined && outcome.reasoning !== '') {
      await this.engine.ledger.append(session.sessionId, {
        type: 'reasoning.thinking',
        turn: turn.turn,
        step,
        parent: outcome.spanId,
        text: outcome.reasoning,
      });
    }

    // The visible text is the message content; wait for every tool call to be
    // parsed (its intent or question is captured in order) before persisting.
    turn.currentReasonText = outcome.text;
    await this.awaitParses(turn);
    if (turn.finished) return { ok: false, error: 'interrupted' };

    const workerOutput = buildWorkerOutput(outcome.text, workerLines);
    const terminal = this.isTerminalStep(turn, outcome.text);
    await this.engine.ledger.append(session.sessionId, {
      type: 'reasoning.completed',
      turn: turn.turn,
      step,
      parent: outcome.spanId,
      text: outcome.text,
      workerOutput,
    });
    turn.reasonCompleted = true;
    await this.flushResults(session, turn);

    // Exactly one communication invocation per nonempty output, immediately
    // after persisting — the action executions are deliberately not awaited. A
    // terminal step reuses this same invocation to end the turn.
    if (workerOutput.trim() !== '') {
      this.replies.request(session, turn, {
        step,
        status: terminal ? 'completed' : 'running',
        terminal,
      });
    }
    return { ok: true, terminal };
  }

  /**
   * True when a successful reason step ends the turn: ordinary visible text
   * with no tool call, or a single question sent alone. A correction, any
   * executed action, or extra questions keep the turn running.
   */
  private isTerminalStep(turn: TurnRuntime, prose: string): boolean {
    if (turn.correctionRequired) return false;
    const hasActions = turn.actionsThisStep > 0;
    if (turn.asksThisStep.length === 1 && !hasActions) return true;
    return turn.toolCallsThisStep === 0 && prose.trim() !== '' && !hasHandwrittenAction(prose);
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
      if (event.type !== 'files.attached') continue;
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
   * correction, a question is remembered for the step decision, and a valid
   * action starts executing immediately. Each valid call appends its raw intent
   * or question to the step's ordered worker output.
   */
  private async handleToolCall(
    session: SessionRuntime,
    turn: TurnRuntime,
    step: number,
    call: ToolCall,
    workerLines: string[],
  ): Promise<void> {
    turn.toolCallsThisStep += 1;
    // An agent tool port dispatches its own native tools by name: an unknown
    // name forces the same correction an invalid built-in call does, and ask
    // does not exist for a port.
    const port = this.engine.host.agentTools?.(session.sessionId);
    if (port !== undefined) {
      const tool = port.tools.find((candidate) => candidate.name === call.name);
      if (tool === undefined) {
        turn.correctionRequired = true;
        await this.engine.appendError(session.sessionId, 'reason', `unknown tool: ${call.name}`, turn, step);
        return;
      }
      const auxiliary = port.auxiliaryTools?.[call.name];
      if (auxiliary !== undefined) {
        const request = auxiliaryToolRequest(call.arguments);
        if (request === undefined) {
          turn.correctionRequired = true;
          await this.engine.appendError(
            session.sessionId,
            'reason',
            `invalid arguments for tool ${call.name}: expected a non-empty "request" string`,
            turn,
            step,
          );
          return;
        }
        turn.portToolCallsThisTurn += 1;
        const ordinal = turn.portToolCallsThisTurn;
        await this.startAction(session, turn, step, { type: auxiliary, intent: request, name: call.name }, ordinal);
        return;
      }
      turn.portToolCallsThisTurn += 1;
      // The call's own ordinal is captured after the increment: calls in one
      // synchronous batch each keep their own position against the cap.
      const ordinal = turn.portToolCallsThisTurn;
      await this.startAction(session, turn, step, { type: 'tool', name: call.name, intent: call.arguments }, ordinal);
      return;
    }
    const parsed = parseActionCall(call);
    if ('error' in parsed) {
      turn.correctionRequired = true;
      await this.engine.appendError(session.sessionId, 'reason', `invalid action call: ${parsed.error}`, turn, step);
      return;
    }
    if (parsed.type === 'ask') {
      turn.asksThisStep.push(parsed.intent);
      workerLines.push(`- ask: ${parsed.intent}`);
      return;
    }
    workerLines.push(`- ${parsed.type}: ${parsed.intent}`);
    await this.startAction(session, turn, step, { type: parsed.type as ActionType, intent: parsed.intent });
  }

  /** Start one parsed action, exactly as a valid block once did. */
  private async startAction(
    session: SessionRuntime,
    turn: TurnRuntime,
    step: number,
    action: ParsedAction,
    toolOrdinal?: number,
  ): Promise<void> {
    turn.actionsThisStep += 1;
    const actionId = this.engine.nextActionId(session);

    const runtimeAction: RuntimeAction = {
      actionId,
      turn: turn.turn,
      step,
      type: action.type,
      goal: describeAction(action),
      startedAt: this.engine.now().toISOString(),
    };
    turn.actions.set(actionId, runtimeAction);
    await this.engine.ledger.append(session.sessionId, {
      type: 'action.started',
      turn: turn.turn,
      step,
      id: actionId,
      parent: stepId(turn.turn, step),
      action: { type: action.type, prompt: action.intent },
      input: action,
    });

    const executeContext: ActionRunContext = {
      ...this.actionBaseContext(session, turn),
      actionId,
      onTaskRun: (taskRunId: string) => this.recordTaskRun(turn, runtimeAction, taskRunId),
      onTitle: (title: string) => this.recordActionTitle(session, turn, step, actionId, title),
    };
    const promise = this.runAction(session, turn, action, executeContext, actionId, step, toolOrdinal);
    turn.actionPromises.add(promise);
    void promise.then(
      () => turn.actionPromises.delete(promise),
      () => turn.actionPromises.delete(promise),
    );
    this.engine.track(promise);
  }

  /**
   * Remember a dispatch's task run in memory so an interrupt or a restart can
   * cancel it. The run id is durable on the task span (`request.taskRunId`) and
   * on `action.finished`; the action gets no second `action.started`.
   */
  private async recordTaskRun(
    turn: TurnRuntime,
    runtimeAction: RuntimeAction,
    taskRunId: string,
  ): Promise<void> {
    runtimeAction.taskRunId = taskRunId;
    turn.taskRunIds.add(taskRunId);
    if (turn.abort.signal.aborted) await this.engine.safeCancelTask(taskRunId);
  }

  /** Publish a model-named title for one running action. */
  private recordActionTitle(
    session: SessionRuntime,
    turn: TurnRuntime,
    step: number,
    actionId: string,
    title: string,
  ): void {
    const promise = this.appendActionTitle(session, turn, step, actionId, title);
    this.engine.track(promise);
  }

  private async appendActionTitle(
    session: SessionRuntime,
    turn: TurnRuntime,
    step: number,
    actionId: string,
    title: string,
  ): Promise<void> {
    try {
      await this.engine.ledger.append(session.sessionId, {
        type: 'action.titled',
        turn: turn.turn,
        step,
        id: actionId,
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
    step: number,
    toolOrdinal?: number,
  ): Promise<void> {
    let outcome: ActionExecutionOutcome;
    try {
      if (action.type === 'tool') {
        outcome = await this.runToolAction(session, turn, action, toolOrdinal);
      } else {
        // A port-originated auxiliary action is subject to the same per-turn
        // cap as a native tool call; a built-in action never is.
        const port = action.name === undefined ? undefined : this.engine.host.agentTools?.(session.sessionId);
        if (port !== undefined && (toolOrdinal ?? turn.portToolCallsThisTurn) > (port.maxToolCalls ?? 24)) {
          outcome = { status: 'failed', result: 'tool call limit reached; end the turn', deferred: [] };
        } else {
          outcome = await session.actions.execute(action, ctx);
        }
      }
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
        step,
        id: actionId,
        action: { type: action.type },
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

  /**
   * Execute one agent-tool-port call. The port is re-read from the host, so the
   * action always runs against the current port. Only a call whose own ordinal
   * (counted across steps) is beyond the cap fails without running.
   */
  private async runToolAction(
    session: SessionRuntime,
    turn: TurnRuntime,
    action: ParsedAction,
    toolOrdinal?: number,
  ): Promise<ActionExecutionOutcome> {
    const port = this.engine.host.agentTools?.(session.sessionId);
    if (port === undefined) {
      return { status: 'failed', result: `unknown tool: ${action.name ?? ''}`, deferred: [] };
    }
    if ((toolOrdinal ?? turn.portToolCallsThisTurn) > (port.maxToolCalls ?? 24)) {
      return { status: 'failed', result: 'tool call limit reached; end the turn', deferred: [] };
    }
    const result = await port.run(
      { name: action.name ?? '', arguments: action.intent },
      { sessionId: session.sessionId, turn: turn.turn },
    );
    return { status: result.status === 'done' ? 'done' : 'failed', result: result.result, deferred: [] };
  }

  private async awaitParses(turn: TurnRuntime): Promise<void> {
    while (turn.parsePromises.size > 0) {
      await Promise.allSettled([...turn.parsePromises]);
    }
  }

  private async awaitStepActions(turn: TurnRuntime): Promise<void> {
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
   * Append queued results, but only once the step's `reasoning.completed` is on
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
          if (draft.type === 'document.content' && this.engine.ledger.read(session.sessionId).some((event) =>
            event.type === 'document.content' && event.path === draft.path && event.version === draft.version)) continue;
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
      step: turn.step,
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
      step: turn.step,
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

/** Upstream-reported input tokens of the most recent finished reasoning span. */
function lastReasonInputTokens(events: readonly LedgerEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'span.finished' && event.kind === 'reasoning') return event.metrics?.usage?.inputTokens;
  }
  return undefined;
}

/** A draft whose body is a read (dropped from a failed/interrupted turn). */
function isReadDraft(draft: LedgerEventDraft): boolean {
  switch (draft.type) {
    case 'document.content':
      return draft.source === 'read' || draft.source === 'project-instructions';
    case 'files.attached':
      return draft.source === 'read';
    case 'memory.recalled':
      return true;
    default:
      return false;
  }
}

/** The trimmed `request` argument of one tool call, or undefined when it is not a non-empty string. */
function auxiliaryToolRequest(args: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const request = (parsed as { request?: unknown }).request;
    if (typeof request !== 'string') return undefined;
    const trimmed = request.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

/** Intent-only description of one typed action, for the running-action table. */
function describeAction(action: ParsedAction): string {
  return `${action.type}: ${oneLine(action.intent)}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * The complete worker output of one reason step: the visible prose followed by
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
