/**
 * session action layer: the typed action model and the router that dispatches
 * one parsed action to its auxiliary task.
 *
 * The reasoning model declares one native tool; the API returns parsed calls.
 * There is no hand-written text parsing layer. Each auxiliary task returns
 * context events as deferred drafts so the engine keeps append ordering.
 */

import type {
  LedgerEvent,
  LedgerEventDraft,
  TaskBrief,
  TaskSpanFinishedEvent,
  TaskSpanStartedEvent,
  WorkspaceSnapshot,
} from '../ledger/store.ts';
import type { ActionStatus, ActionType } from '../ledger/store.ts';
import type { CallsPort, FilesPort, ProjectInfo, SessionHost } from '../ports.ts';
import type { FileStore } from '../media.ts';
import { runSearchAction } from '../auxiliary/search.ts';
import { runDispatchAction } from '../auxiliary/dispatch.ts';
import { runDocumentAction } from '../auxiliary/document.ts';
import { runTodoAction } from '../auxiliary/todo.ts';
import { runVcsAction } from '../auxiliary/vcs.ts';
import { runProjectAction } from '../auxiliary/project.ts';

export type { ActionStatus, ActionType } from '../ledger/store.ts';

// ─── Typed action model ────────────────────────────────────────────────────

/** One reasoning action the model wrote: its type plus the natural-language intent. */
export interface ParsedAction {
  type: ActionType;
  intent: string;
  /**
   * The native tool name of a `tool` action started through an agent tool port;
   * absent for every built-in action.
   */
  name?: string;
}

/** Result of executing one action. */
export interface ActionExecutionOutcome {
  taskRunId?: string;
  status: ActionStatus;
  result: string;
  taskStatus?: string;
  task?: string;
  /** Drafts whose append is deferred until after the step's reasoning event. */
  deferred: LedgerEventDraft[];
}

// ─── Ports ──────────────────────────────────────────────────────────────────

export type ActionProjectInfo = Pick<ProjectInfo, 'id' | 'displayName' | 'workspaceDir' | 'checkoutPath'>;

export type ActionTaskInfo = Pick<TaskBrief, 'id' | 'description' | 'inputSummary'> & { project?: string };

/** One observational task span body the dispatch runner appends immediately. */
export type TaskSpanDraft =
  | Omit<TaskSpanStartedEvent, 'seq' | 'at'>
  | Omit<TaskSpanFinishedEvent, 'seq' | 'at'>;

export interface ActionRunnerDeps {
  host: Pick<SessionHost, 'describeTask' | 'mountedTaskTools' | 'createTaskRun' | 'waitTaskRun' | 'cancelTaskRun' | 'taskRunActive' | 'methods' | 'call' | 'environmentTools'>;
  files: Pick<FilesPort, 'checkPath' | 'exists' | 'read' | 'instructionChain' | 'listDocuments' | 'readDocumentRules'>;
  calls: CallsPort;
  fileStore: FileStore;
  /**
   * Append one observational span draft immediately, before any deferred
   * content draft. Used for the task span pair of a dispatch.
   */
  appendSpan(draft: TaskSpanDraft): void | Promise<void>;
  now(): Date;
}

/**
 * The deps one auxiliary task receives: the shared action deps plus a fresh
 * span id from the owning runner, so every auxiliary call keeps one sequence.
 */
export interface ActionWorkflowDeps extends ActionRunnerDeps {
  nextSpanId(): string;
}

/**
 * Everything one action needs. The engine supplies a fresh `currentEvents`
 * read per call, so an action always sees the timeline as of now.
 */
export interface ActionRunContext {
  sessionId: string;
  turn: number;
  step: number;
  /** The owning action id; auxiliary spans use it as their `parent`. */
  actionId: string;
  userText: string;
  workspaceRoot: string;
  snapshot: WorkspaceSnapshot;
  currentEvents(): LedgerEvent[];
  projects: ActionProjectInfo[];
  tasks: ActionTaskInfo[];
  signal: AbortSignal;
  onTaskRun(taskRunId: string): Promise<void>;
  onTitle?(title: string): void;
  onDispatched?(): void;
}

// ─── Action runner ──────────────────────────────────────────────────────────

/**
 * Routes the typed actions to their auxiliary task. The runner never appends
 * context events itself: every path that produces context events returns
 * deferred drafts.
 */
export class ActionRunner {
  private readonly deps: ActionRunnerDeps;
  private spanSeq = 0;

  constructor(deps: ActionRunnerDeps) {
    this.deps = deps;
  }

  async execute(action: ParsedAction, ctx: ActionRunContext): Promise<ActionExecutionOutcome> {
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
        // `tool` runs through the session host's agent tool port and `schedule`
        // no longer exists, so neither ever reaches the action runner.
        throw new Error(`unsupported action type: ${action.type}`);
    }
  }
}
