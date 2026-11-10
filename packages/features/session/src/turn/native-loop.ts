/**
 * session turn loop: the shared work-turn state machine and step loop over the
 * session runtime, plus the built-in runner. `engine.ts` owns the session
 * lifecycle and calls into a loop for everything a turn does.
 */

import {
  contextImageFiles,
  stepId,
  turnId,
  type LedgerEvent,
  type StepStatus,
} from '../ledger/store.ts';
import { resolveModelMetadata } from '@wrenyard/ai/metadata';
import { ACTION_TOOL } from '../reasoning/tool.ts';
import { buildReason } from '../reasoning/prompt.ts';
import { runMemorySearch } from '../auxiliary/memory.ts';
import type { ReplyWriter } from '../auxiliary/reply.ts';
import { startInitialTitle } from '../auxiliary/title.ts';
import type { CallFailureSummary, SessionCallHost, SessionViewInfo } from '../ports.ts';
import type { ToolSpec } from '@wrenyard/ai/transport';
import type { SessionRuntime, TurnRuntime } from './runtime.ts';
import { messageOf } from '../errors.ts';
import type { ActionRunner } from './actions.ts';
import type { Compaction } from './compaction.ts';

/** Step 1 blocks on memory search only up to this long before reasoning starts. */
const MEMORY_SEARCH_STEP1_WAIT_MS = 8000;

/** The prompt and tools one turn runs on, plus facts kept across compaction. */
export interface LoopAgent {
  tools: readonly ToolSpec[];
  system?: string;
  kernelFacts?: () => string | undefined;
}

/** Run the turn and step loop over the session runtime. */
export abstract class TurnLoop {
  /** At most one memory-search invocation per turn; cleared when it settles. */
  private readonly memorySearchFlights = new WeakMap<TurnRuntime, Promise<void>>();

  constructor(
    protected readonly engine: SessionCallHost,
    private readonly replies: ReplyWriter,
    private readonly actions: ActionRunner,
    private readonly compaction: Compaction,
  ) {}

  /** The agent surface this loop's turns run on. */
  protected abstract agent(session: SessionRuntime): LoopAgent;

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

          // Memory search overlaps reasoning after step 1: step 1 waits at most
          // MEMORY_SEARCH_STEP1_WAIT_MS; later steps start search without awaiting.
          turn.phase = 'preparing';
          await this.prepareMemorySearchForStep(session, turn, step);
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
          await this.actions.awaitStepActions(turn);
          if (turn.finished) return;

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
        await this.actions.cancelRunningWork(turn);
        await this.actions.awaitParses(turn);
        await this.actions.awaitStepActions(turn);
        await this.actions.flushResults(session, turn);
        if (turn.finished) return;
        turn.abort = new AbortController();
        await this.replies.close(session, turn, messageOf(error));
      }
    }
  }

  /**
   * Start memory search for this step when none is in flight. Step 1 waits up
   * to MEMORY_SEARCH_STEP1_WAIT_MS; later steps proceed to reasoning immediately.
   */
  private async prepareMemorySearchForStep(
    session: SessionRuntime,
    turn: TurnRuntime,
    step: number,
  ): Promise<void> {
    this.ensureMemorySearch(session, turn, step);
    if (step !== 1) return;
    const search = this.memorySearchFlights.get(turn);
    if (search === undefined) return;
    await Promise.race([
      search,
      new Promise<void>((resolve) => { setTimeout(resolve, MEMORY_SEARCH_STEP1_WAIT_MS); }),
    ]);
  }

  /** Run at most one memory search per turn; in-flight work is not restarted. */
  private ensureMemorySearch(session: SessionRuntime, turn: TurnRuntime, step: number): void {
    if (this.memorySearchFlights.has(turn)) return;
    const promise = runMemorySearch(this.engine, session, turn, step).finally(() => {
      if (this.memorySearchFlights.get(turn) === promise) this.memorySearchFlights.delete(turn);
    });
    this.memorySearchFlights.set(turn, promise);
    this.engine.track(promise);
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
    const models = await this.engine.host.gateway().then((connection) => connection.models, () => []);
    const metadata = resolveModelMetadata(turn.publicId, models);
    const allowImages = metadata.imageInput === true;
    // The step marker is appended before the request is assembled: it renders
    // as this step's `<wy-info>` line, so the request only ever grows at its end.
    const previous = this.engine.ledger.read(session.sessionId);
    const lastInputTokens = lastReasonInputTokens(previous);
    const stepKey = stepId(turn.turn, step);
    const steersSeen = turn.steers ?? 0;
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
    // The loop owns the system prompt and tool set for this session; the built-in
    // loop keeps the single wy_action tool, while a bot loop supplies its port.
    const agent = this.agent(session);
    const tools = agent.tools;
    const buildView = (currentEvents: LedgerEvent[]) => buildReason({
      deviceName: this.engine.host.deviceName,
      snapshot: session.snapshot,
      events: currentEvents,
      userText: turn.userText,
      session: this.sessionInfo(session, turn),
      images,
      allowImages,
      ...(agent.system === undefined ? {} : { systemOverride: agent.system }),
    });
    let view = buildView(events);

    // The compaction decision bounds this step's rendered view; a view that
    // cannot be brought under the window fails the turn naming the sizes.
    const compaction = await this.compaction.prepare({
      session,
      turn,
      step,
      stepKey,
      events,
      models,
      metadata,
      maxTokens,
      view,
      kernelFacts: agent.kernelFacts,
      buildView,
    });
    if (!compaction.ok) return { ok: false, error: compaction.error };
    view = compaction.view;

    // The reason call declares this loop's tools; completed calls are started
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
        ...(turn.model.automatic === true ? { automatic: true } : {}),
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
        const promise = this.actions.handleToolCall(session, turn, step, call, workerLines)
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
      await this.actions.cancelRunningWork(turn);
      await this.actions.awaitParses(turn);
      await this.actions.awaitStepActions(turn);
      await this.actions.flushResults(session, turn);
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
    await this.actions.awaitParses(turn);
    if (turn.finished) return { ok: false, error: 'interrupted' };

    const workerOutput = buildWorkerOutput(outcome.text, workerLines);
    // A message steered in after this step's context was read keeps the turn
    // running, so the next step carries it to the model.
    const terminal = this.isTerminalStep(turn, outcome.text) && (turn.steers ?? 0) === steersSeen;
    if (terminal) turn.closing = true;
    await this.engine.ledger.append(session.sessionId, {
      type: 'reasoning.completed',
      turn: turn.turn,
      step,
      parent: outcome.spanId,
      text: outcome.text,
      workerOutput,
    });
    turn.reasonCompleted = true;
    await this.actions.flushResults(session, turn);

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
}

// ─── built-in loop ─────────────────────────────────────────────────────────

/** The ordinary session loop: the built-in orchestrator prompt and wy_action. */
export class NativeLoop extends TurnLoop {
  protected agent(_session: SessionRuntime): LoopAgent {
    return { tools: [ACTION_TOOL] };
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
