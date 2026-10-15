/**
 * The session transport's sole retry implementation.
 *
 * Every retryable failure of every protocol adapter is retried here under one
 * policy, judged only by the protocol's own signals: connection errors,
 * timeouts, a pre-output stream break, and HTTP 408/409/429/5xx. An account
 * quota exhaustion, any other 4xx, a protocol error, a post-output break and a
 * cancellation are never retried. Overload and rate limiting are not
 * distinguished. A genuine upstream failure retries with exponential backoff,
 * bounded by the caller's own deadline.
 *
 * Two things are not upstream retries and are handled as a bounded recovery
 * wait in this same loop: a local Gateway admission refusal (the circuit
 * declined to admit the request before any upstream call) and an adopted
 * upstream hint that names a not-before instant. Neither replays after output
 * started or after cancellation; an admission refusal never consumes the
 * upstream retry count, and a hint of any length (a minute or longer) is
 * honoured exactly. A caller-supplied route-health read is re-checked before
 * every actual attempt, so a cooling-down route is waited out here instead of
 * probed early and refused. The recovery wait is bounded to a cumulative
 * {@link MAX_RECOVERY_WAIT_MS} per logical main model call and is never reset by
 * repeated admission refusals; when the advertised wait would exceed the
 * remaining bound the call stops with one explicit recoverable failure carrying
 * `retryAt` instead of probing early.
 */
import { ModelError, abortError, isQuotaCode } from './errors.ts';
import type { ModelWaitReason, RetryAfterHint } from './protocol.ts';

/** Failed attempts after the first, so one call issues at most five requests. */
export const MAX_RETRIES = 4;

/** First backoff step; each subsequent step doubles it. */
export const BASE_DELAY_MS = 2_000;

/**
 * Cumulative bounded recovery wait for one logical main model call. Repeated
 * admission refusals draw on the same budget and never reset it.
 */
export const MAX_RECOVERY_WAIT_MS = 5 * 60_000;

/** Bounded minimum wait applied to a recovery, so the caller never spins. */
export const MIN_RECOVERY_DELAY_MS = 1_000;

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
  /**
   * Present when this wait is a bounded recovery wait rather than an ordinary
   * upstream retry: `reason` distinguishes waiting for permission to probe a
   * locally blocked route (`admission`) from a guaranteed recovery, and
   * `retryAt` is the absolute instant the next probe/recovery is due.
   */
  wait?: { reason: ModelWaitReason; retryAt: string };
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
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Optional route-health check, run before every actual attempt inside this
   * same loop: it returns the absolute instant (epoch ms) the route may next be
   * probed, or `undefined` when the route is callable now. It is re-read before
   * the initial attempt and again after every wait, so a route that entered or
   * extended its cooldown between attempts is waited out in this one budget
   * instead of probed early and refused. This keeps the route-health wait in the
   * single retry budget — there is no second nested retry owner. Cancellation,
   * not `outputStarted`, gates it.
   */
  preflight?: () => number | undefined;
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
 * jitter. `retryAfterMs` is kept for callers that already hold an absolute
 * hint delay; a hint wait is normally scheduled from its not-before instant.
 */
export function retryDelayMs(attempt: number, retryAfterMs: number | undefined, random: () => number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const base = BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = JITTER_MIN + random() * (JITTER_MAX - JITTER_MIN);
  return Math.round(base * jitter);
}

/**
 * The absolute instant (epoch ms) before which no next attempt may start, or
 * `undefined` when the failure is an ordinary one that uses exponential
 * backoff. An admission refusal always yields an instant — its advertised
 * probe time, or a bounded minimum — so it never spins and never consumes an
 * upstream retry.
 */
function notBeforeMs(failure: ModelError, admission: boolean, now: () => number): number | undefined {
  if (failure.retryAt !== undefined) {
    const parsed = Date.parse(failure.retryAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (failure.retryAfter !== undefined) return failure.retryAfter.retryAt;
  if (failure.retryAfterMs !== undefined) return now() + failure.retryAfterMs;
  return admission ? now() + MIN_RECOVERY_DELAY_MS : undefined;
}

/** Carry the absolute not-before instant on a terminal bounded-wait failure. */
function recoverableFailure(failure: ModelError, retryAt: string): ModelError {
  if (failure.retryAt !== undefined) return failure;
  return new ModelError(failure.message, {
    kind: failure.kind,
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
    ...(failure.retryAfter === undefined ? {} : { retryAfter: failure.retryAfter }),
    ...(failure.source === undefined ? {} : { source: failure.source }),
    ...(failure.upstream === undefined ? {} : { upstream: failure.upstream }),
    ...(failure.shouldRetry === undefined ? {} : { shouldRetry: failure.shouldRetry }),
    ...(failure.outputStarted ? { outputStarted: true } : {}),
    ...(failure.metrics === undefined ? {} : { metrics: failure.metrics }),
    retryAt,
    cause: failure,
  });
}

/**
 * Run one call attempt under the shared retry policy. `run` performs a single
 * request and throws a {@link ModelError} on any failure.
 *
 * A genuine retryable upstream failure consumes the retry budget and waits the
 * exponential backoff, or an adopted hint's not-before instant. A local
 * admission refusal and a hint wait are bounded recovery waits in the same
 * loop: they never replay after output started, a cancellation aborts any wait
 * immediately, and an admission refusal never spends an upstream retry.
 */
export async function runWithRetry<T>(run: () => Promise<T>, context: RetryContext): Promise<T> {
  const random = context.random ?? Math.random;
  const now = context.now ?? Date.now;
  let attempt = 1;
  /** Cumulative bounded recovery wait of this logical call; never reset. */
  let recoveryWaitedMs = 0;
  for (;;) {
    // A cancellation stops the loop before the route-health read and, below,
    // before the request itself.
    if (context.signal.aborted) throw abortError();
    // Re-read route health before every actual attempt — the initial one and
    // each one that follows a wait — so a route that entered (or extended) its
    // cooldown is waited out inside this one budget rather than probed early and
    // rejected by the Gateway. Same loop, same cumulative budget: no second
    // nested retry owner and no separate preflight budget.
    const blockedUntil = context.preflight?.();
    if (blockedUntil !== undefined && blockedUntil > now()) {
      const delayMs = Math.max(MIN_RECOVERY_DELAY_MS, blockedUntil - now());
      if (recoveryWaitedMs + delayMs > MAX_RECOVERY_WAIT_MS) {
        throw recoverableFailure(
          new ModelError('Route is cooling down beyond the recovery budget', { kind: 'server', source: 'admission' }),
          new Date(blockedUntil).toISOString(),
        );
      }
      context.onRetry({
        attempt,
        kind: 'server',
        delayMs,
        wait: { reason: 'admission', retryAt: new Date(blockedUntil).toISOString() },
      });
      await wait(delayMs, context.signal);
      recoveryWaitedMs += delayMs;
      continue;
    }
    // A cancellation that landed while reading route health is honoured before
    // the request is actually issued.
    if (context.signal.aborted) throw abortError();
    try {
      return await run();
    } catch (error) {
      const failure = error instanceof ModelError ? error : new ModelError(messageOf(error), { kind: 'protocol' });
      if (context.signal.aborted) throw abortError();
      // A local admission refusal is never an upstream retry: it must not
      // consume the retry count, and it is never replayed once output started.
      const admission = failure.source === 'admission';
      if (admission) {
        if (context.outputStarted() || failure.outputStarted) throw failure;
      } else if (attempt > MAX_RETRIES || !isRetryable(failure, context.outputStarted())) {
        throw failure;
      }
      const notBefore = notBeforeMs(failure, admission, now);
      if (notBefore === undefined) {
        const delayMs = retryDelayMs(attempt, undefined, random);
        context.onRetry({
          attempt,
          kind: failure.kind,
          ...(failure.status === undefined ? {} : { status: failure.status }),
          delayMs,
        });
        await wait(delayMs, context.signal);
        attempt += 1;
        continue;
      }
      const delayMs = Math.max(MIN_RECOVERY_DELAY_MS, notBefore - now());
      if (recoveryWaitedMs + delayMs > MAX_RECOVERY_WAIT_MS) {
        // The advertised wait exceeds the remaining bounded budget: one
        // explicit recoverable failure carrying `retryAt`, never an early probe.
        throw recoverableFailure(failure, new Date(notBefore).toISOString());
      }
      context.onRetry({
        attempt,
        kind: failure.kind,
        ...(failure.status === undefined ? {} : { status: failure.status }),
        delayMs,
        wait: { reason: admission ? 'admission' : 'recovery', retryAt: new Date(notBefore).toISOString() },
        // Only a hint that was actually adopted is reported; a pure backoff
        // decision carries no retryAfter.
        ...(failure.retryAfter === undefined ? {} : { retryAfter: failure.retryAfter }),
      });
      await wait(delayMs, context.signal);
      recoveryWaitedMs += delayMs;
      // Only a real upstream try spends the retry budget; an admission refusal
      // waits without consuming one.
      if (!admission) attempt += 1;
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
