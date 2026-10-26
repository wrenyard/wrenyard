/**
 * session runtime state: the in-memory bookkeeping of one live session and its
 * turns. None of it is durable; the ledger is the source of truth.
 */

import type { ReasoningEffort } from '@wrenyard/models';
import type { LedgerEventDraft, ActionType, TurnStatus, WorkspaceSnapshot } from '../ledger/store.ts';
import type { ActionRunner } from '../reasoning/actions.ts';
import type { CallsPort, FilesPort, TurnPhase } from '../ports.ts';

export interface RuntimeAction {
  actionId: string;
  turn: number;
  step: number;
  type: ActionType;
  goal: string;
  startedAt: string;
  taskRunId?: string;
}

export interface ResultBundle {
  finished: LedgerEventDraft;
  deferred: LedgerEventDraft[];
}

export interface TurnRuntime {
  turn: number;
  userText: string;
  /** Stable identity of this turn's attachment inputs, for the recovery dedup. */
  attachmentsKey: string;
  model: {
    provider: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    /** Explicit Fast preference for this turn; absent means no preference. */
    fast?: boolean;
    /** True when automatic routing chose this model; absent for a hand-picked one. */
    automatic?: boolean;
    /** Auto-selection provenance recorded on the turn. */
    autoSelected?: boolean;
  };
  publicId: string;
  contextWindow?: number;
  /** True when this turn carried images the reasoning model cannot see. */
  imageUnsupported: boolean;
  phase: TurnPhase;
  status?: TurnStatus;
  step: number;
  /** The step id currently in progress, set once its `step.started` lands. */
  currentStepId?: string;
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
  actionsThisStep: number;
  /** Completed wy_action tool calls seen this step. */
  toolCallsThisStep: number;
  /** Natural-language questions collected from this step's tool calls. */
  asksThisStep: string[];
  /** Tool calls being parsed/started; separate from the executions they spawn. */
  parsePromises: Set<Promise<void>>;
  actionPromises: Set<Promise<void>>;
  stepText: string;
  taskRunIds: Set<string>;
  /** Set when the last reason step produced an invalid action call or question. */
  correctionRequired: boolean;
  /** Set once an empty reason output has been sent back for correction. */
  emptyReasonRetried: boolean;
  /** The visible text of the last successful reason output. */
  currentReasonText: string;
  /** Steered messages accepted into this turn so far. */
  steers?: number;
  /** Set once a step decided to end the turn; later steers start a new turn. */
  closing?: boolean;
}

export interface SessionRuntime {
  sessionId: string;
  workspaceRoot: string;
  snapshot: WorkspaceSnapshot;
  files: FilesPort;
  actions: ActionRunner;
  calls: CallsPort;
  /** Session-wide span id counter. */
  spanSeq: number;
  /** Session-wide action id counter, shared by reasoning and system actions. */
  actionSeq: number;
  title: string;
  lastTitleVersion: number;
  titleVersion: number;
  firstUserText?: string;
  turns: Map<number, TurnRuntime>;
  nextTurn: number;
  /**
   * Tail of the queue of main reasoning requests. Turns may run in parallel,
   * but their reasoning requests go out one at a time so the conversation each
   * request sees is one linear, append-only history.
   */
  reasonQueue: Promise<void>;
  /**
   * Tail of the session-scoped queue of communication (reply) invocations.
   * Replies are serialized per session, and each request builds its ledger view
   * when it is dequeued, so it always sees the earlier assistant replies.
   */
  replyQueue: Promise<void>;
}
