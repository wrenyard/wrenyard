/**
 * Model-call fact types carried on the session wire: auxiliary call roles,
 * measured call metrics, usage, finish reasons, per-attempt records, adopted
 * upstream retry hints and the normalized transport failure kinds. Declared
 * here so the ledger event types in `./ledger.ts` and IPC consumers share one
 * definition, with no import from a runtime package.
 */
export type AuxiliaryCallRole = 'title' | 'memory-search' | 'search' | 'dispatch' | 'document' | 'todo' | 'vcs' | 'project' | 'reply' | 'status' | 'suggestion' | 'task-output';

/** Normalized failure class; overloads are folded into `server`. */
export type ModelErrorKind =
  | 'network'
  | 'server'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'auth'
  | 'model_unavailable'
  | 'invalid_request'
  | 'context_overflow'
  | 'protocol'
  | 'interrupted'
  | 'aborted';

/**
 * Provider-reported usage. Only fields the upstream actually reported are set;
 * a missing value stays absent instead of being replaced by `0`.
 */
export interface Usage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

/** Normalized completion reason. */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

/** Which upstream response header supplied an adopted retry hint. */
export type RetryAfterSource = 'retry-after' | 'retry-after-ms';

/**
 * An upstream retry hint the transport actually adopted. The original header
 * value is kept verbatim so a caller can record the supplier's own wording in
 * the ledger; `delayMs` is the wait that was applied and `retryAt` is that wait
 * expressed as an absolute not-before instant (epoch ms), so a hint longer than
 * a minute is honoured exactly instead of being re-clamped relative to a later
 * clock read.
 */
export interface RetryAfterHint {
  source: RetryAfterSource;
  value: string;
  delayMs: number;
  /** Absolute instant (epoch ms) before which no retry may start. */
  retryAt: number;
}

/** One request actually issued during a call, in order. */
export interface ModelAttempt {
  /** HTTP status of this request, when one was received. */
  status?: number;
  /** Failure kind of this request; absent on the successful one. */
  error?: ModelErrorKind;
  /** Duration of this request in milliseconds. */
  ms: number;
  /** Wait before this request, when it is a retry. */
  waitedMs?: number;
  /** Present only when an upstream retry hint was adopted for that wait. */
  retryAfter?: RetryAfterHint;
  /** The route this request was issued for, when a caller distinguishes routes. */
  model?: string;
  /** When this route is expected to recover, from an adopted hint or route state. */
  routeUntil?: string;
}

/** Measured facts of one completed or failed call, produced by the transport. */
export interface ModelMetrics {
  /** Model id the upstream reported, when it differs or is known. */
  responseModel?: string;
  finishReason?: FinishReason;
  usage?: Usage;
  /** Milliseconds from the first request being sent to the first output (text, reasoning or tool-call argument). */
  ttftMs?: number;
  /** Total time visible content was streaming, from the shared sampler. */
  streamMs?: number;
  /** Sampler token count of that streamed content. */
  streamTokens?: number;
  /** Every request actually issued, in order. */
  attempts: ModelAttempt[];
}
