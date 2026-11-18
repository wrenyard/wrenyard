/**
 * Harness runtime state: the in-memory bookkeeping of one live session and its
 * turns. None of it is durable; the session timeline is the source of truth.
 */

import type { ReasoningEffort } from '@wrenyard/models';
import type { ActionType, LedgerEventDraft, TurnStatus, WorkspaceSnapshot } from '../events.ts';
import type { CallsPort, FilesPort, TurnPhase } from '../ports.ts';
import type { ActionRunner } from '../drivers/executor.ts';

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
  /** Stable identity of this turn's attachment inputs, for recovery dedup. */
  attachmentsKey: string;
  model: {
    provider: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    fast?: boolean;
    automatic?: boolean;
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
  /** In-flight `step.finished` append so interrupt waits for exact ordering. */
  stepFinishPromise?: Promise<void>;
  abort: AbortController;
  actions: Map<string, RuntimeAction>;
  finished: boolean;
  /** Set once `driver.interruptTurn` begins so `onAbort` does not skip cleanup. */
  interruptHandled?: boolean;
  /** Changes only after the terminal durable append lands. */
  durableTerminal: boolean;
  resultQueue: ResultBundle[];
  flushPromise: Promise<void>;
  /** Set when reasoning failed: late results are still recorded, reads are not. */
  dropDeferred: boolean;
  reasonCompleted: boolean;
  actionsThisStep: number;
  toolCallsThisStep: number;
  asksThisStep: string[];
  parsePromises: Set<Promise<void>>;
  actionPromises: Set<Promise<void>>;
  stepText: string;
  taskRunIds: Set<string>;
  correctionRequired: boolean;
  emptyReasonRetried: boolean;
  currentReasonText: string;
  steers?: number;
  closing?: boolean;
  /** Notifies `@wrenyard/session` TurnRecord synchronously before durable terminal appends. */
  onClaimFinish?: () => void;
  /** Notifies `@wrenyard/session` ManagedSession once terminal durability lands. */
  onDurableTerminal?: (status: 'completed' | 'failed') => void;
}

export interface SessionRuntime {
  sessionId: string;
  workspaceRoot: string;
  snapshot: WorkspaceSnapshot;
  files: FilesPort;
  actions: ActionRunner;
  calls: CallsPort;
  spanSeq: number;
  actionSeq: number;
  title: string;
  lastTitleVersion: number;
  titleVersion: number;
  firstUserText?: string;
  turns: Map<number, TurnRuntime>;
  nextTurn: number;
  reasonQueue: Promise<void>;
  replyQueue: Promise<void>;
}
