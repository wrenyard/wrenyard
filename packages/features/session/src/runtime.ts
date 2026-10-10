/**
 * session runtime state: the in-memory bookkeeping of one live session and its
 * turns. None of it is durable; the ledger is the source of truth.
 */

import type { ReasoningEffort } from '@wrenyard/models';
import type { LedgerEventDraft, TurnStatus, WorkspaceSnapshot } from './ledger.ts';
import type { ActionKind, ActionRunner } from './actions/index.ts';
import type { CallsPort, FilesPort, TurnPhase } from './ports.ts';

export interface RuntimeAction {
  actionId: string;
  turn: number;
  cycle: number;
  kind: ActionKind;
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
  model: { provider: string; model: string; reasoningEffort: ReasoningEffort };
  publicId: string;
  contextWindow?: number;
  /** True when this turn carried images the reasoning model cannot see. */
  imageUnsupported: boolean;
  phase: TurnPhase;
  status?: TurnStatus;
  cycle: number;
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
  actionsThisCycle: number;
  /** Completed wy_action tool calls seen this cycle. */
  toolCallsThisCycle: number;
  /** Natural-language questions collected from this cycle's tool calls. */
  asksThisCycle: string[];
  actionSeq: number;
  /** Tool calls being parsed/started; separate from the executions they spawn. */
  parsePromises: Set<Promise<void>>;
  actionPromises: Set<Promise<void>>;
  cycleText: string;
  taskRunIds: Set<string>;
  /** Set when the last reason cycle produced an invalid action call or question. */
  correctionRequired: boolean;
  /** Set once an empty reason output has been sent back for correction. */
  emptyReasonRetried: boolean;
  /** The visible text of the last successful reason output. */
  currentReasonText: string;
}

export interface SessionRuntime {
  sessionId: string;
  workspaceRoot: string;
  snapshot: WorkspaceSnapshot;
  files: FilesPort;
  actions: ActionRunner;
  calls: CallsPort;
  callSeq: number;
  title: string;
  lastTitleVersion: number;
  titleVersion: number;
  titleUpdatedWithReply: boolean;
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
