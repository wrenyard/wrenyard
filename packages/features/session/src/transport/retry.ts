/**
 * The session transport's sole retry implementation.
 *
 * Every retryable failure of every protocol adapter is retried here under one
 * policy, judged only by the protocol's own signals: connection errors,
 * timeouts, a pre-output stream break, and HTTP 408/409/429/5xx. An account
 * quota exhaustion, any other 4xx, a protocol error, a post-output break and a
 * cancellation are never retried. Overload and rate limiting are not
 * distinguished. The policy has no time budget: the caller's own deadline is
 * the only bound.
 */
import { ModelError, abortError, isQuotaCode } from './errors.ts';
import type { RetryAfterHint } from './protocol.ts';

/** Failed attempts after the first, so one call issues at most five requests. */
export const MAX_RETRIES = 4;

/** First backoff step; each subsequent step doubles it. */
export const BASE_DELAY_MS = 2_000;

/** Jitter multiplier range applied to the exponential backoff. */
const JITTER_MIN = 0.75;
const JITTER_MAX = 1.0;

/** One retry the transport decided to make. */
export interface RetryDecision {
  /** 1-based retry ordinal. */
  attempt: number;
  kind: ModelError['kind'];
  status?: number;
  /** The wait before this retry, after jitter or an upstream hint. */
  delayMs: number;
  /**
   * Present only when the upstream retry hint was actually adopted for this
   * retry, with the header's original value. An exponential-backoff retry never
   * carries it.
   */
  retryAfter?: RetryAfterHint;
}

/** Context the retry loop reports through and observes. */
export interface RetryContext {
  signal: AbortSignal;
  /** True once the call has produced any text, reasoning or tool-call output. */
  outputStarted(): boolean;
  /** Called before the wait of each retry. */
  onRetry(decision: RetryDecision): void;
  /** Injectable jitter for deterministic tests; defaults to `Math.random`. */
  random?: () => number;
}

/**
 * True when a failure may be retried on the same route. An explicit upstream
 * `x-should-retry` decides when present, but never past the post-output or
 * cancellation boundary, which is checked by {@link runWithRetry}.
 */
export function isRetryable(error: ModelError, outputStarted: boolean): boolean {
  if (error.kind === 'aborted') return false;
  if (outputStarted || error.outputStarted) return false;
  if (error.shouldRetry !== undefined) return error.shouldRetry;
  if (error.kind === 'quota_exhausted') return false;
  // The protocol's own status codes decide first, so an official 409/429/5xx is
  // retryable even when its kind would otherwise be a non-retryable 4xx.
  if (error.status !== undefined) {
    if (error.status === 408 || error.status === 409 || error.status >= 500) return true;
    if (error.status === 429) return !isQuotaCode(error.upstream?.code);
  }
  switch (error.kind) {
    case 'network':
    case 'server':
    case 'rate_limited':
      return true;
    default:
      return false;
  }
}

/**
 * Wait before retry `attempt` (1-based): `2s × 2^(n−1)` times a 0.75–1.0
 * jitter, or the upstream hint when one was adopted (already capped at 60 s by
 * the adapter).
 */
export function retryDelayMs(attempt: number, retryAfterMs: number | undefined, random: () => number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const base = BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = JITTER_MIN + random() * (JITTER_MAX - JITTER_MIN);
  return Math.round(base * jitter);
}

/**
 * Run one call attempt under the shared retry policy. `run` performs a single
 * request and throws a {@link ModelError} on any failure.
 */
export async function runWithRetry<T>(run: () => Promise<T>, context: RetryContext): Promise<T> {
  const random = context.random ?? Math.random;
  let attempt = 1;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      const failure = error instanceof ModelError ? error : new ModelError(messageOf(error), { kind: 'protocol' });
      if (context.signal.aborted) throw abortError();
      if (attempt > MAX_RETRIES || !isRetryable(failure, context.outputStarted())) throw failure;
      const delayMs = retryDelayMs(attempt, failure.retryAfterMs, random);
      context.onRetry({
        attempt,
        kind: failure.kind,
        ...(failure.status === undefined ? {} : { status: failure.status }),
        delayMs,
        // Only a hint that was actually adopted is reported; a pure backoff
        // decision carries no retryAfter.
        ...(failure.retryAfterMs === undefined || failure.retryAfter === undefined
          ? {}
          : { retryAfter: failure.retryAfter }),
      });
      await wait(delayMs, context.signal);
      attempt += 1;
    }
  }
}

/** Wait `ms`, rejecting immediately when the signal aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
