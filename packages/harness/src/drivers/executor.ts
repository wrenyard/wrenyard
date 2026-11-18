/**
 * Harness action executor: the `wy_action` primary tool definition and parser,
 * the typed auxiliary action dispatcher, and the turn-level result queue.
 */

import { record, stringField, type ToolCall, type ToolSpec } from '@wrenyard/ai/transport';
import { stepId, type ActionType, type LedgerEventDraft } from '../events.ts';
import { messageOf } from '../errors.ts';
import type {
  ActionBaseContext,
  ActionExecutionOutcome,
  ActionRunContext,
  ActionRunnerDeps,
  ActionWorkflowDeps,
  ParsedAction,
  SessionCallHost,
} from '../ports.ts';
import { runSearchAction } from '../auxiliary/search.ts';
import { runDispatchAction } from '../auxiliary/dispatch.ts';
import { runDocumentAction } from '../auxiliary/document.ts';
import { runTodoAction } from '../auxiliary/todo.ts';
import { runVcsAction } from '../auxiliary/vcs.ts';
import { runProjectAction } from '../auxiliary/project.ts';
import { runInAuxiliarySubSession, type ManagedSessionLookup } from './auxiliary.ts';
import type { RuntimeAction, SessionRuntime, TurnRuntime } from './runtime.ts';

export type {
  ActionExecutionOutcome,
  ActionProjectInfo,
  ActionRunContext,
  ActionRunnerDeps,
  ActionTaskInfo,
  ActionWorkflowDeps,
  ParsedAction,
  TaskSpanDraft,
} from '../ports.ts';
export type { ActionStatus, ActionType } from '../events.ts';

/** The one native tool the built-in orchestrator reasoning call declares. */
export const ACTION_TOOL: ToolSpec = {
  name: 'wy_action',
  description:
    'Use search to read workspace material, dispatch to dispatch a task, document to create or revise ordinary spec/report/handoff documents under existing rules or read/revise the existing registered project AGENTS.md through doc.* using fixed id AGENTS.md, todo to list and show workspace todos through the read-only native todo.list and todo.get methods. Sessions cannot create, update, tag, comment on, or otherwise mutate todos; do not bypass this restriction through tasks or other tools. Never read todo files directly. Vcs manages version control of the workspace repository, project manages a registered project checkout, and ask asks the user one question that needs their decision. Document actions cannot create or delete AGENTS.md or other instruction files, edit workspace-root or nested checkout instruction files, target arbitrary paths, or change other workspace, configuration or source files. You can call it several times at once. Each call expresses one thing, with intent in natural language.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['search', 'dispatch', 'document', 'todo', 'vcs', 'project', 'ask'],
        description: 'search = read workspace material by intent or exact path, dispatch = dispatch a task in a project, document = ordinary spec/report/handoff documents under existing rules plus read/revise existing registered project AGENTS.md through doc.* with fixed id AGENTS.md; document actions cannot create/delete AGENTS.md or other instruction files, target workspace-root or nested checkout instruction files, arbitrary paths, or other workspace/config/source files, todo = read-only list and show through todo.list and todo.get; sessions cannot mutate todos or bypass this restriction through tasks or other tools, vcs = version control of the workspace repository itself, project = manage a registered project checkout including worktrees, ask = ask the user one question that needs their decision.',
      },
      intent: { type: 'string', description: 'The intent of this action, in natural language.' },
    },
    required: ['type', 'intent'],
  },
};

export function parseActionCall(call: ToolCall): { type: string; intent: string } | { error: string } {
  let parsed: Record<string, unknown> | undefined;
  let error: string | undefined;
  try {
    parsed = record(JSON.parse(call.arguments));
  } catch {
    error = 'invalid arguments JSON';
  }
  const type = stringField(parsed?.type) ?? '';
  const intent = stringField(parsed?.intent) ?? '';
  if (error === undefined && type === '') error = 'missing type';
  if (error === undefined && intent === '') error = 'missing intent';
  if (error !== undefined) return { error };
  if (
    type !== 'search'
    && type !== 'dispatch'
    && type !== 'document'
    && type !== 'todo'
    && type !== 'vcs'
    && type !== 'project'
    && type !== 'ask'
  ) {
    return { error: `unknown action type: ${type}` };
  }
  return { type, intent };
}

/**
 * Routes typed auxiliary actions (`search`, `dispatch`, `document`, `todo`,
 * `vcs`, `project`), running each inside a tracked sub-session when bound.
 */
export class ActionRunner {
  private readonly deps: ActionRunnerDeps;
  private readonly managedLookup?: ManagedSessionLookup;
  private spanSeq = 0;

  constructor(deps: ActionRunnerDeps, managedLookup?: ManagedSessionLookup) {
    this.deps = deps;
    this.managedLookup = managedLookup;
  }

  async execute(action: ParsedAction, ctx: ActionRunContext): Promise<ActionExecutionOutcome> {
    const managed = this.managedLookup?.(ctx.sessionId);
    return runInAuxiliarySubSession(
      managed,
      { parentEventId: ctx.actionId, input: action },
      ctx.signal,
      (subSignal) => this.executeInner(action, { ...ctx, signal: subSignal }),
    );
  }

  private executeInner(action: ParsedAction, ctx: ActionRunContext): Promise<ActionExecutionOutcome> {
    const workflow: ActionWorkflowDeps = {
      ...this.deps,
      nextSpanId: () => `s${ctx.turn}.${ctx.step}.x${++this.spanSeq}`,
    };
    switch (action.type) {
      case 'search':
        return runSearchAction(workflow, action, ctx);
      case 'dispatch':
        return runDispatchAction(workflow, action, ctx);
      case 'document':
        return runDocumentAction(this.deps, action, ctx);
      case 'todo':
        return runTodoAction(this.deps, action, ctx);
      case 'vcs':
        return runVcsAction(this.deps, action, ctx);
      case 'project':
        return runProjectAction(this.deps, action, ctx);
      default:
        throw new Error(`unsupported action type: ${action.type}`);
    }
  }
}

/** Turn-scoped tool-call dispatch, action execution, and ordered result flushing. */
export class TurnActionExecutor {
  constructor(protected readonly engine: SessionCallHost) {}

  async cancelRunningWork(turn: TurnRuntime): Promise<void> {
    await Promise.allSettled([...turn.taskRunIds].map((id) => this.engine.safeCancelTask(id)));
  }

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
    this.engine.trackTurnWork(session.sessionId, turn.turn, promise);
  }

  private async recordTaskRun(
    turn: TurnRuntime,
    runtimeAction: RuntimeAction,
    taskRunId: string,
  ): Promise<void> {
    runtimeAction.taskRunId = taskRunId;
    turn.taskRunIds.add(taskRunId);
    if (turn.abort.signal.aborted) await this.engine.safeCancelTask(taskRunId);
  }

  private recordActionTitle(
    session: SessionRuntime,
    turn: TurnRuntime,
    step: number,
    actionId: string,
    title: string,
  ): void {
    const promise = this.appendActionTitle(session, turn, step, actionId, title);
    this.engine.trackTurnWork(session.sessionId, turn.turn, promise);
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

  private async enqueueResult(
    session: SessionRuntime,
    turn: TurnRuntime,
    finished: LedgerEventDraft,
    deferred: LedgerEventDraft[],
  ): Promise<void> {
    turn.resultQueue.push({ finished, deferred });
    if (turn.reasonCompleted) await this.flushResults(session, turn);
  }

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
    this.engine.trackTurnWork(session.sessionId, turn.turn, turn.flushPromise);
    await work;
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

function describeAction(action: ParsedAction): string {
  return `${action.type}: ${oneLine(action.intent)}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
