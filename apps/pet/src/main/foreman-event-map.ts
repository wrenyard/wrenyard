// src/main/foreman-event-map.ts

import type {
  ForgeEventSignal,
  LifecycleSignal,
  ToolResultSignal,
  TurnUsageSignal,
} from './forge-types';

// ── Event type mapping ──

export type EventsEventType =
  | 'task.started'
  | 'task.done'
  | 'task.failed'
  | 'dispatch'
  | 'child-start'
  | 'queue-acquired'
  | 'queue-waiting'
  | 'lock-lost'
  | 'terminal'
  | 'turn-complete'
  | 'cancelled'
  | 'result'
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'turn_usage';

export interface EventsLine {
  type: EventsEventType;
  timestamp?: unknown;
  ts?: unknown;
  status?: unknown;
  exit_code?: unknown;
  data?: EventsLineData;
  role?: unknown;
  text?: unknown;
  name?: unknown;
  input_summary?: unknown;
  call_id?: unknown;
  output_tail?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  duration_ms?: unknown;
  is_error?: unknown;
  summary?: unknown;
}

export interface EventsLineData {
  role?: unknown;
  text?: unknown;
  name?: unknown;
  input_summary?: unknown;
  call_id?: unknown;
  status?: unknown;
  output_tail?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  duration_ms?: unknown;
  exit_code?: unknown;
  exitCode?: unknown;
  is_error?: unknown;
  summary?: unknown;
}

/**
 * Map a single Foreman event to a normalized ForgeEventSignal.
 */
export function mapForgeEvent(obj: EventsLine, hasSpawn: boolean): ForgeEventSignal | null {
  const ts = parseEventTimestamp(obj);
  if (ts === null) return null;

  switch (obj.type) {
    case 'task.started':
      return null;
    case 'task.done':
      return lifecycleSignal('done', ts, eventSummary(obj));
    case 'task.failed':
      return lifecycleSignal('failed', ts, eventSummary(obj));
    case 'dispatch':
      if (!hasSpawn) {
        return { kind: 'spawn', ts };
      }
      return { kind: 'working', ts };
    case 'child-start':
      return { kind: 'working', ts };
    case 'queue-acquired':
      return { kind: 'working', ts };
    case 'queue-waiting':
      return { kind: 'queued', ts };
    case 'lock-lost':
      return { kind: 'failed', ts };
    case 'terminal':
      return mapTerminal(obj, ts);
    case 'turn-complete':
      return null;
    case 'cancelled':
      return { kind: 'failed', ts };
    case 'result':
      return mapResult(obj, ts);
    case 'message':
      return mapMessage(obj, ts);
    case 'tool_call':
      return mapToolCall(obj, ts);
    case 'tool_result':
      return mapToolResult(obj, ts);
    case 'turn_usage':
      return mapTurnUsage(obj, ts);
    default:
      return null;
  }
}

function mapTerminal(obj: EventsLine, ts: number): LifecycleSignal {
  const status = obj.data?.status ?? obj.status;
  const summary = eventSummary(obj);

  // Primary: check forge-native status field.
  if (typeof status === 'string') {
    if (status === 'done') {
      return lifecycleSignal('done', ts, summary);
    }
    if (
      status === 'failed' ||
      status === 'stalled' ||
      status === 'cancelled' ||
      status === 'error'
    ) {
      return lifecycleSignal('failed', ts, summary);
    }
  }

  const exitCode = obj.data?.exit_code ?? obj.data?.exitCode ?? obj.exit_code;

  // Fallback: check legacy exit_code.
  if (typeof exitCode === 'number') {
    if (exitCode === 0) {
      return lifecycleSignal('done', ts, summary);
    }
    return lifecycleSignal('failed', ts, summary);
  }

  // No status or exit_code → default to failed
  return lifecycleSignal('failed', ts, summary);
}

function mapTurnComplete(obj: EventsLine, ts: number): LifecycleSignal {
  const exitCode = obj.data?.exit_code ?? obj.data?.exitCode ?? obj.exit_code;
  const summary = eventSummary(obj);

  if (typeof exitCode === 'number' && exitCode !== 0) {
    return lifecycleSignal('failed', ts, summary);
  }
  const status = obj.data?.status ?? obj.status;
  if (typeof status === 'string') {
    if (
      status === 'failed' ||
      status === 'stalled' ||
      status === 'cancelled' ||
      status === 'error'
    ) {
      return lifecycleSignal('failed', ts, summary);
    }
  }
  return lifecycleSignal('done', ts, summary);
}

function mapResult(obj: EventsLine, ts: number): LifecycleSignal {
  if (obj.is_error === true || obj.data?.is_error === true) {
    return { kind: 'failed', ts };
  }
  return mapTurnComplete(obj, ts);
}

function mapMessage(obj: EventsLine, ts: number): ForgeEventSignal | null {
  const role = obj.data?.role ?? obj.role;
  const text = obj.data?.text ?? obj.text;

  if (role !== 'assistant') return null;
  if (typeof text !== 'string' || text.length === 0) return null;
  return {
    kind: 'message',
    role: 'assistant',
    text,
    ts,
  };
}

function mapToolCall(obj: EventsLine, ts: number): ForgeEventSignal | null {
  const name = obj.data?.name ?? obj.name;
  const inputSummary = obj.data?.input_summary ?? obj.input_summary;
  const callId = obj.data?.call_id ?? obj.call_id;

  if (typeof name !== 'string' || name.length === 0) return null;

  return {
    kind: 'tool_call',
    name,
    ts,
    ...(typeof inputSummary === 'string' ? { inputSummary } : {}),
    ...(typeof callId === 'string' ? { callId } : {}),
  };
}

function mapToolResult(obj: EventsLine, ts: number): ToolResultSignal | null {
  const callId = obj.data?.call_id ?? obj.call_id;
  const status = obj.data?.status ?? obj.status;
  const outputTail = obj.data?.output_tail ?? obj.output_tail;

  if (typeof callId !== 'string' || callId.length === 0) return null;
  if (status !== 'ok' && status !== 'error') return null;

  return {
    kind: 'tool_result',
    callId,
    status,
    ts,
    ...(typeof outputTail === 'string' ? { outputTail } : {}),
  };
}

function mapTurnUsage(obj: EventsLine, ts: number): TurnUsageSignal | null {
  const inputTokens = numberField(obj.data?.input_tokens ?? obj.input_tokens);
  const outputTokens = numberField(obj.data?.output_tokens ?? obj.output_tokens);
  const durationMs = numberField(obj.data?.duration_ms ?? obj.duration_ms);

  if (inputTokens === undefined && outputTokens === undefined && durationMs === undefined) {
    return null;
  }

  return {
    kind: 'turn_usage',
    ts,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function eventSummary(obj: EventsLine): string | undefined {
  const value = obj.data?.summary ?? obj.summary;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function lifecycleSignal(kind: 'done' | 'failed', ts: number, summary?: string): LifecycleSignal {
  return summary ? { kind, ts, summary } : { kind, ts };
}

function parseEventTimestamp(obj: EventsLine): number | null {
  if (typeof obj.timestamp === 'string') {
    const ms = Date.parse(obj.timestamp);
    return Number.isFinite(ms) ? ms : null;
  }

  // Legacy compatibility for older fixtures. Foreman's event contract is
  // timestamp:RFC3339; this path is intentionally secondary.
  if (typeof obj.ts === 'number' && Number.isFinite(obj.ts)) {
    return obj.ts;
  }

  return null;
}
