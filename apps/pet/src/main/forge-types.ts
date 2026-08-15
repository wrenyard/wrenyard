// src/main/forge-types.ts
// Shared interface contract — single source of truth for data layer types.
// Application-layer tasks must import (or re-export) from this file.

export type Phase = 'working' | 'sleeping' | 'celebrating' | 'dejected';

export type LifecycleSignal =
  | { kind: 'spawn'; ts: number }
  | { kind: 'queued'; ts: number }
  | { kind: 'working'; ts: number }
  | { kind: 'sleeping'; ts: number }
  | { kind: 'done'; ts: number; summary?: string }
  | { kind: 'failed'; ts: number; summary?: string };

export interface ToolUseSignal {
  name: string;
  ts: number;
  inputSummary?: string;
  callId?: string;
}

export interface TextSignal {
  text: string;
  ts: number;
}

export interface MessageSignal extends TextSignal {
  kind: 'message';
  role: 'assistant';
}

export interface ToolCallSignal extends ToolUseSignal {
  kind: 'tool_call';
}

export interface ToolResultSignal {
  kind: 'tool_result';
  callId: string;
  status: 'ok' | 'error';
  ts: number;
  outputTail?: string;
}

export interface TurnUsageSignal {
  kind: 'turn_usage';
  ts: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

export type ForgeEventSignal =
  | LifecycleSignal
  | MessageSignal
  | ToolCallSignal
  | ToolResultSignal
  | TurnUsageSignal;

export interface SessionMetaData {
  workerIdentityKey: string;
  /** Actual Foreman task_run_id, preserved separately from the worker key. */
  foremanTaskRunID?: string;
  profile: string;
  clientFamily?: string;
  workDir: string;
  label?: string;
  project?: string;
  isWorktree: boolean;
  status: string;
  taskId?: string;
  taskName?: string;
  taskLabel?: string;
}

export interface LivenessVerdict {
  alive: boolean;
  reason: string;
}

// WorkerSnapshot is the shared application-layer worker representation.
// Listed in the final review as a forge-types single-source type.
export interface WorkerSnapshot {
  workerIdentityKey: string;
  profile: string;
  phase: Phase;
  phaseSinceMs: number;
  toolCount: number;
  firstSentence?: string;
  lastText?: string;
  bubbleUntilMs?: number;
  lastToolName?: string;
  lastToolStatus?: 'ok' | 'error';
  lastToolOutputTail?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  startedAt: number;
  meta: SessionMetaData;
}
