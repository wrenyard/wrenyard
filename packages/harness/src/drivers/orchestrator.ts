/**
 * Orchestrator turn loop driver over `@wrenyard/loop`'s {@link runAgentLoop}.
 *
 * Keeps all memory-search gating, XML projector rendering, compaction fallback,
 * `wy_action` tool dispatch, reply queueing, and step finalization intact while
 * sharing the loop skeleton.
 */

import { runAgentLoop } from '@wrenyard/loop';
import { resolveModelMetadata } from '@wrenyard/ai/metadata';
import type { ToolSpec } from '@wrenyard/ai/transport';
import type { ManagedSession } from '@wrenyard/session';
import {
  contextImageFiles,
  stepId,
  turnId,
  type LedgerEvent,
  type SessionSummary,
  type StepStatus,
} from '../events.ts';
import { messageOf } from '../errors.ts';
import { Compaction } from '../context/compaction.ts';
import { createReasoningProjector } from '../context/projector.ts';
import { runMemorySearch } from '../auxiliary/memory.ts';
import type { ReplyWriter } from '../auxiliary/reply.ts';
import { startInitialTitle } from '../auxiliary/title.ts';
import type { CallFailureSummary, SessionCallHost, SessionViewInfo } from '../ports.ts';
import type { HarnessTurnInput } from '../types.ts';
import { ACTION_TOOL, TurnActionExecutor } from './executor.ts';
import type { SessionRuntime, TurnRuntime } from './runtime.ts';

const MEMORY_SEARCH_STEP1_WAIT_MS = 8000;

export interface LoopAgent {
  tools: readonly ToolSpec[];
  system?: string;
  kernelFacts?: () => string | undefined;
}

export abstract class TurnLoop {
  private readonly memorySearchFlights = new WeakMap<TurnRuntime, Promise<void>>();

  constructor(
    protected readonly engine: SessionCallHost,
    private readonly replies: ReplyWriter,
    readonly actions: TurnActionExecutor,
    private readonly compaction: Compaction,
  ) {}

  protected abstract agent(session: SessionRuntime): LoopAgent;

  async runTurn(
    session: SessionRuntime,
    turn: TurnRuntime,
    options?: {
      managed?: ManagedSession<LedgerEvent, HarnessTurnInput, SessionSummary>;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    const outerSignal = options?.signal;
    await runAgentLoop({
      isFinished: () => turn.finished,
      isAborted: () => turn.abort.signal.aborted || (outerSignal?.aborted ?? false),
      prepareStep: async (step) => {
        turn.step = step;
        turn.actionsThisStep = 0;
        turn.toolCallsThisStep = 0;
        turn.asksThisStep = [];
        turn.reasonCompleted = false;
        turn.correctionRequired = false;
        turn.stepText = '';
        turn.currentReasonText = '';
        turn.currentStepId = undefined;

        if (turn.turn === 1 && step === 1) startInitialTitle(this.engine, session, turn);
        turn.phase = 'preparing';
        await this.prepareMemorySearchForStep(session, turn, step);
      },
      runModelStep: async (step) => {
        turn.phase = 'reasoning';
        return this.queueReason(session, () => this.runReason(session, turn, step, options?.managed));
      },
      onTurnFailed: async (error, failure) => {
        await this.replies.close(session, turn, error, failure as CallFailureSummary | undefined);
      },
      executeStepActions: async (step) => {
        turn.phase = 'acting';
        await this.actions.awaitStepActions(turn);
        if (turn.finished) return { continueLoop: false };

        const asks = turn.asksThisStep;
        const actionRan = turn.actionsThisStep > 0;

        if (asks.length > 1) {
          await this.engine.appendError(session.sessionId, 'reason', 'only one ask is allowed per output', turn, step);
          turn.correctionRequired = true;
          return { continueLoop: true };
        }

        if (asks.length === 1 && actionRan) {
          await this.engine.appendError(session.sessionId, 'reason', 'ask must be sent alone; it was ignored', turn, step);
          return { continueLoop: true };
        }

        if (turn.toolCallsThisStep === 0) {
          if (turn.currentReasonText.trim() === '') {
            const reason = 'reason call returned no visible output';
            await this.engine.appendError(session.sessionId, 'reason', reason, turn, step);
            if (turn.emptyReasonRetried) {
              await this.replies.close(session, turn, reason);
              return { continueLoop: false };
            }
            turn.emptyReasonRetried = true;
            return { continueLoop: true };
          }

          if (hasHandwrittenAction(turn.currentReasonText)) {
            await this.engine.appendError(
              session.sessionId,
              'reason',
              'actions can only be started through the wy_action tool',
              turn,
              step,
            );
            turn.correctionRequired = true;
            return { continueLoop: true };
          }
        }

        return { continueLoop: true };
      },
      finishStep: async (_step, status) => {
        await session.replyQueue;
        const resolvedStatus: StepStatus = turn.finished || turn.abort.signal.aborted
          ? (turn.status === 'failed' ? 'failed' : 'interrupted')
          : status;
        await this.finishStep(session, turn, resolvedStatus);
      },
      onTurnException: async (error) => {
        turn.dropDeferred = true;
        turn.reasonCompleted = true;
        turn.abort.abort();
        await this.actions.cancelRunningWork(turn);
        await this.actions.awaitParses(turn);
        await this.actions.awaitStepActions(turn);
        await this.actions.flushResults(session, turn);
        if (turn.finished || (outerSignal?.aborted ?? false)) return;
        turn.abort = new AbortController();
        await this.replies.close(session, turn, messageOf(error));
      },
    });
  }

  /** Flush buffered action results on the turn. */
  async flushResults(session: SessionRuntime, turn: TurnRuntime): Promise<void> {
    await this.actions.flushResults(session, turn);
  }

  /** Close an open step id at most once; shared with interrupt handling. */
  async finishStep(session: SessionRuntime, turn: TurnRuntime, status: StepStatus): Promise<void> {
    const id = turn.currentStepId;
    if (id === undefined) return;
    turn.currentStepId = undefined;
    const promise = (async () => {
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
    })();
    turn.stepFinishPromise = promise;
    await promise;
    if (turn.stepFinishPromise === promise) turn.stepFinishPromise = undefined;
  }

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
      new Promise<void>((resolve) => {
        setTimeout(resolve, MEMORY_SEARCH_STEP1_WAIT_MS);
      }),
    ]);
  }

  private ensureMemorySearch(session: SessionRuntime, turn: TurnRuntime, step: number): void {
    if (this.memorySearchFlights.has(turn)) return;
    const promise = runMemorySearch(this.engine, session, turn, step).finally(() => {
      if (this.memorySearchFlights.get(turn) === promise) this.memorySearchFlights.delete(turn);
    });
    this.memorySearchFlights.set(turn, promise);
    this.engine.track(promise);
  }

  private async queueReason<T>(session: SessionRuntime, task: () => Promise<T>): Promise<T> {
    const previous = session.reasonQueue;
    let release!: () => void;
    session.reasonQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
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
    managed?: ManagedSession<LedgerEvent, HarnessTurnInput, SessionSummary>,
  ): Promise<{ ok: true; terminal: boolean } | { ok: false; error: string; failure?: CallFailureSummary }> {
    const models = await this.engine.host.gateway().then((connection) => connection.models, () => []);
    const metadata = resolveModelMetadata(turn.publicId, models);
    const allowImages = metadata.imageInput === true;
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

    if (!allowImages && contextImageFiles(events).size > 0) turn.imageUnsupported = true;
    const images: Record<string, { dataUrl: string; mime: string }> = allowImages
      ? await this.collectReasonImages(session, events)
      : {};

    const maxTokens = metadata.maxOutputTokens;
    const agent = this.agent(session);
    const tools = agent.tools;
    const buildView = (currentEvents: LedgerEvent[]) => {
      const projector = createReasoningProjector({
        deviceName: this.engine.host.deviceName,
        snapshot: session.snapshot,
        userText: turn.userText,
        session: this.sessionInfo(session, turn),
        images,
        allowImages,
        ...(agent.system === undefined ? {} : { systemOverride: agent.system }),
      });
      if (managed !== undefined && managed.timeline.lastSeq === (currentEvents.at(-1)?.seq ?? 0)) {
        return managed.project(projector);
      }
      return projector.fold(
        currentEvents.filter((event) => projector.isSurfaceEvent?.(event) ?? true),
        currentEvents,
      );
    };
    let view = buildView(events);

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
        this.engine.trackTurnWork(session.sessionId, turn.turn, promise);
      },
    });

    if (turn.finished) return { ok: false, error: 'interrupted' };

    if (!outcome.ok) {
      turn.reasonCompleted = true;
      turn.dropDeferred = true;
      turn.abort.abort();
      await this.actions.cancelRunningWork(turn);
      await this.actions.awaitParses(turn);
      await this.actions.awaitStepActions(turn);
      await this.actions.flushResults(session, turn);
      if (!turn.finished) turn.abort = new AbortController();
      return {
        ok: false,
        error: outcome.error ?? 'reason call failed',
        ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
      };
    }

    if (outcome.reasoning !== undefined && outcome.reasoning !== '') {
      await this.engine.ledger.append(session.sessionId, {
        type: 'reasoning.thinking',
        turn: turn.turn,
        step,
        parent: outcome.spanId,
        text: outcome.reasoning,
      });
    }

    turn.currentReasonText = outcome.text;
    await this.actions.awaitParses(turn);
    if (turn.finished) return { ok: false, error: 'interrupted' };

    const workerOutput = buildWorkerOutput(outcome.text, workerLines);
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

    if (workerOutput.trim() !== '') {
      this.replies.request(session, turn, {
        step,
        status: terminal ? 'completed' : 'running',
        terminal,
      });
    }
    return { ok: true, terminal };
  }

  private isTerminalStep(turn: TurnRuntime, prose: string): boolean {
    if (turn.correctionRequired) return false;
    const hasActions = turn.actionsThisStep > 0;
    if (turn.asksThisStep.length === 1 && !hasActions) return true;
    return turn.toolCallsThisStep === 0 && prose.trim() !== '' && !hasHandwrittenAction(prose);
  }

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

/** The built-in orchestrator loop: default prompt plus `wy_action`. */
export class OrchestratorLoop extends TurnLoop {
  constructor(engine: SessionCallHost, replies: ReplyWriter) {
    super(engine, replies, new TurnActionExecutor(engine), new Compaction(engine));
  }

  protected agent(_session: SessionRuntime): LoopAgent {
    return { tools: [ACTION_TOOL] };
  }
}

function lastReasonInputTokens(events: readonly LedgerEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'span.finished' && event.kind === 'reasoning') return event.metrics?.usage?.inputTokens;
  }
  return undefined;
}

function buildWorkerOutput(prose: string, lines: readonly string[]): string {
  if (lines.length === 0) return prose;
  const block = lines.join('\n');
  return prose.trim() === '' ? block : `${prose}\n${block}`;
}

function hasHandwrittenAction(text: string): boolean {
  return text.includes('<action') || text.includes('<wy-action');
}
