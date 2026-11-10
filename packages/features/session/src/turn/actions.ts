/**
 * session turn actions: tool-call dispatch, action execution, task-run and
 * title recording, and the ordered result flush every turn shares.
 */

import {
  stepId,
  type LedgerEventDraft,
} from '../ledger/store.ts';
import { type ToolCall } from '@wrenyard/ai/transport';
import { parseActionCall } from '../reasoning/tool.ts';
import {
  type ActionExecutionOutcome,
  type ActionRunContext,
  type ParsedAction,
  type ActionType,
} from '../reasoning/actions.ts';
import type { ActionBaseContext, SessionCallHost } from '../ports.ts';
import type { RuntimeAction, SessionRuntime, TurnRuntime } from './runtime.ts';
import { messageOf } from '../errors.ts';

/** Run the turn's tool calls and action executions over the session runtime. */
export class ActionRunner {
  constructor(protected readonly engine: SessionCallHost) {}

  async cancelRunningWork(turn: TurnRuntime): Promise<void> {
    await Promise.allSettled([...turn.taskRunIds].map((id) => this.engine.safeCancelTask(id)));
  }

  /**
   * Apply one completed wy_action tool call: an invalid call forces a
   * correction, a question is remembered for the step decision, and a valid
   * action starts executing immediately. Each valid call appends its raw intent
   * or question to the step's ordered worker output.
   */
  async handleToolCall(
    session: SessionRuntime,
    turn: TurnRuntime,
    step: number,
    call: ToolCall,
    workerLines: string[],
  ): Promise<void> {
    turn.toolCallsThisStep += 1;
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
  protected async startAction(
    session: SessionRuntime,
    turn: TurnRuntime,
    step: number,
    action: ParsedAction,
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
    const promise = this.runAction(session, turn, action, executeContext, actionId, step);
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
  ): Promise<void> {
    let outcome: ActionExecutionOutcome;
    try {
      if (action.type === 'tool') {
        outcome = await this.runToolAction(session, turn, action);
      } else {
        outcome = await session.actions.execute(action, ctx);
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

  /** Execute a native tool action; a loop with a port overrides this. */
  protected async runToolAction(
    _session: SessionRuntime,
    _turn: TurnRuntime,
    action: ParsedAction,
  ): Promise<ActionExecutionOutcome> {
    return { status: 'failed', result: `unknown tool: ${action.name ?? ''}`, deferred: [] };
  }

  async awaitParses(turn: TurnRuntime): Promise<void> {
    while (turn.parsePromises.size > 0) {
      await Promise.allSettled([...turn.parsePromises]);
    }
  }

  async awaitStepActions(turn: TurnRuntime): Promise<void> {
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
          await this.engine.ledger.append(session.sessionId, draft);
        }
      }
    });
    turn.flushPromise = work.catch(() => undefined);
    await work;
  }

  // ── helpers ─────────────────────────────────────────────────────────────

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
export function auxiliaryToolRequest(args: string): string | undefined {
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
