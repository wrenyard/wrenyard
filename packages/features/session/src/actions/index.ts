/**
 * session action layer: the typed action model and the router that dispatches
 * one parsed action to its secondary runner.
 *
 * The reasoning model declares one native tool; the API returns parsed calls.
 * There is no hand-written text parsing layer. Each secondary runner returns
 * context events as deferred drafts so the engine keeps append ordering.
 */

import type { LedgerEvent, TaskBrief, WorkspaceSnapshot } from '../ledger.ts';
import type { CallsPort, FilesPort, ProjectInfo, SessionHost } from '../ports.ts';
import type { FileStore } from '../media.ts';
import { runSearchAction } from './secondary/search.ts';
import { runDispatchAction } from './dispatch/dispatch.ts';
import { runDocumentAction } from './secondary/document.ts';
import { runVcsAction } from './secondary/vcs.ts';
import { runProjectAction } from './secondary/project.ts';

// ─── Typed action model ────────────────────────────────────────────────────

export type ActionKind = 'search' | 'dispatch' | 'document' | 'vcs' | 'project';
export type ActionStatus = 'done' | 'failed' | 'skipped' | 'cancelled';

/** One typed action: its kind plus the natural-language intent body. */
export interface ParsedAction {
  kind: ActionKind;
  intent: string;
}

/** Result of executing one action. */
export interface ActionExecutionOutcome {
  taskRunId?: string;
  status: ActionStatus;
  result: string;
  taskStatus?: string;
  task?: string;
  /** Drafts whose append is deferred until after the cycle's reasoning event. */
  deferred: import('../ledger.ts').LedgerEventDraft[];
}

// ─── Ports ──────────────────────────────────────────────────────────────────

export type ActionProjectInfo = Pick<ProjectInfo, 'id' | 'displayName' | 'workspaceDir' | 'checkoutPath'>;

export type ActionTaskInfo = Pick<TaskBrief, 'id' | 'description' | 'inputSummary'> & { project?: string };

export interface ActionRunnerDeps {
  host: Pick<SessionHost, 'describeTask' | 'createTaskRun' | 'waitTaskRun' | 'cancelTaskRun' | 'methods' | 'call'>;
  files: Pick<FilesPort, 'checkPath' | 'exists' | 'read' | 'instructionChain' | 'listDocuments' | 'readDocumentRules'>;
  calls: Pick<CallsPort, 'run'>;
  fileStore: FileStore;
  now(): Date;
}

/**
 * The deps one secondary runner receives: the shared action deps plus a fresh
 * call id from the owning runner, so every auxiliary call keeps one sequence.
 */
export interface ActionWorkflowDeps extends ActionRunnerDeps {
  nextCallId(): string;
}

/**
 * Everything one action needs. The engine supplies a fresh `currentEvents`
 * read per call, so an action always sees the timeline as of now.
 */
export interface ActionRunContext {
  sessionId: string;
  turn: number;
  cycle: number;
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
 * Routes the typed actions to their secondary runner. The runner never appends
 * ledger events itself: every path that produces context events returns
 * deferred drafts.
 */
export class ActionRunner {
  private readonly deps: ActionRunnerDeps;
  private callSeq = 0;

  constructor(deps: ActionRunnerDeps) {
    this.deps = deps;
  }

  async execute(action: ParsedAction, ctx: ActionRunContext): Promise<ActionExecutionOutcome> {
    const workflow: ActionWorkflowDeps = {
      ...this.deps,
      nextCallId: () => `c${ctx.turn}.${ctx.cycle}.x${++this.callSeq}`,
    };
    switch (action.kind) {
      case 'search':
        return runSearchAction(workflow, action, ctx);
      case 'dispatch':
        return runDispatchAction(workflow, action, ctx);
      case 'document':
        return runDocumentAction(this.deps, action, ctx);
      case 'vcs':
        return runVcsAction(this.deps, action, ctx);
      case 'project':
        return runProjectAction(this.deps, action, ctx);
    }
  }
}
