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
 * Two things are not upstream retries and are handled as a recovery wait in
 * this same loop: a local Gateway admission refusal (the circuit declined to
 * admit the request before any upstream call) and an adopted upstream hint that
 * names a not-before instant. Neither replays after output started or after
 * cancellation; an admission refusal never consumes the upstream retry count,
 * and a hint of any length (a minute or longer) is honoured exactly. A
 * caller-supplied route-health read is re-checked before every actual attempt,
 * so a cooling-down route is waited out here instead of probed early and
 * refused.
 *
 * Recovery waiting has no cumulative budget: a route that stays in cooldown is
 * waited out for as long as its real not-before instant requires. One wait
 * owner refreshes the route's preflight state on a short bounded cadence while
 * it sleeps, so a cooldown that is extended or shortened is reflected in the
 * published retry instant and no upstream request is issued before it is due.
 * A wait whose real instant is missing, invalid or already past publishes no
 * retry instant at all and takes the abortable minimum local recheck, so an
 * unknown recovery time stays unknown and no fallback delay is ever published
 * as an ETA. A real upstream hint remains a separate not-before floor that a
 * refreshed route may only move later, never earlier. Every wait is abortable,
 * and long waits are chunked so a timer cannot overflow.
 */
import { ModelError, abortError, isQuotaCode, type ModelErrorKind } from './errors.ts';
import type { ModelWaitReason, RetryAfterHint } from './protocol.ts';

/** Failed attempts after the first, so one call issues at most five requests. */
export const MAX_RETRIES = 4;

/** First backoff step; each subsequent step doubles it. */
export const BASE_DELAY_MS = 2_000;

/**
 * Safe minimum recheck applied to a recovery without an advertised instant, so
 * the caller never spins. It is a local recheck delay, never an ETA.
 */
export const MIN_RECOVERY_DELAY_MS = 1_000;

/**
 * How often an in-progress recovery wait re-reads the route's local preflight
 * state. This bounded cadence notices an extended or shortened cooldown
 * promptly without polling upstream or busy-looping.
 */
export const RECOVERY_RECHECK_MS = 1_000;

/** The largest delay `setTimeout` accepts; any longer wait is chunked. */
const MAX_TIMER_MS = 2_147_483_647;

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
   * Present when this wait is a recovery wait rather than an ordinary upstream
   * retry: `reason` distinguishes waiting for permission to probe a locally
   * blocked route (`admission`) from a guaranteed recovery, and `retryAt` is the
   * absolute instant the next probe/recovery is due, taken only from real route
   * state or a real upstream hint. It is absent when no real instant is known —
   * missing, invalid or already past — so an unknown recovery time is published
   * as unknown instead of as a fabricated `now + delay` ETA.
   */
  wait?: { reason: ModelWaitReason; retryAt?: string };
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
   * the initial attempt, after every wait, and on the wait's own recheck
   * cadence, so a route that entered, extended or shortened its cooldown is
   * waited out here instead of probed early and refused. This keeps the
   * route-health wait in the single retry loop — there is no second nested retry
   * owner. Cancellation, not `outputStarted`, gates it.
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
 * The absolute instant a real advertised not-before names, or `undefined` when
 * the failure carries none and therefore uses exponential backoff. Only a real
 * route instant or a real upstream hint is returned: a local admission refusal
 * without one is never assigned a made-up time, so observers keep it unknown.
 */
function advertisedNotBeforeMs(failure: ModelError, now: () => number): number | undefined {
  if (failure.retryAt !== undefined) {
    const parsed = Date.parse(failure.retryAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (failure.retryAfter !== undefined) return failure.retryAfter.retryAt;
  if (failure.retryAfterMs !== undefined) return now() + failure.retryAfterMs;
  return undefined;
}

/** One recovery wait, owned by the single retry loop. */
interface RecoveryWait {
  attempt: number;
  kind: ModelErrorKind;
  status?: number;
  reason: ModelWaitReason;
  /**
   * A real advertised instant a refreshed route may only move later, never
   * earlier. An upstream hint sets it; a preflight-derived cooldown does not.
   */
  floorMs?: number;
  /**
   * Absolute instant the next attempt is currently due, or `undefined` when no
   * real instant is known — missing, invalid or already past. An unknown
   * instant is published as unknown and waited out with the abortable minimum
   * local recheck; it is never replaced by a fabricated `now + delay` ETA.
   */
  untilMs: number | undefined;
  retryAfter?: RetryAfterHint;
}

/**
 * Sleep until a recovery is due, re-reading the route's local preflight state
 * on a short bounded cadence. Every change in the real not-before instant is
 * published as a fresh wait decision, so observers see an updated retry time
 * without a fabricated ETA and without an early upstream request. A wait with
 * no known instant publishes no `retryAt` at all and then sleeps the abortable
 * minimum local recheck, so an unknown recovery time stays unknown. The wait is
 * abortable at every step and is chunked by the cadence, so even an
 * astronomically long cooldown cannot overflow a timer.
 */
async function waitForRecovery(wait: RecoveryWait, context: RetryContext, now: () => number): Promise<void> {
  const publish = (untilMs: number | undefined, initial: boolean): void => {
    context.onRetry({
      attempt: wait.attempt,
      kind: wait.kind,
      ...(wait.status === undefined ? {} : { status: wait.status }),
      delayMs: untilMs === undefined ? MIN_RECOVERY_DELAY_MS : Math.max(0, untilMs - now()),
      wait: {
        reason: wait.reason,
        ...(untilMs === undefined ? {} : { retryAt: new Date(untilMs).toISOString() }),
      },
      ...(initial && wait.retryAfter !== undefined ? { retryAfter: wait.retryAfter } : {}),
    });
  };
  let untilMs = wait.untilMs;
  publish(untilMs, true);
  // No real instant: one abortable minimum local recheck, never an upstream
  // probe and never a published fallback ETA.
  if (untilMs === undefined) {
    await waitChunk(MIN_RECOVERY_DELAY_MS, context.signal);
    return;
  }
  for (;;) {
    const remaining = untilMs - now();
    if (remaining <= 0) return;
    await waitChunk(Math.min(remaining, RECOVERY_RECHECK_MS), context.signal);
    // A local read only: nothing is sent upstream before the due instant.
    if (context.preflight === undefined) continue;
    const observed = context.preflight();
    const effective = Math.max(wait.floorMs ?? 0, observed ?? 0);
    if (effective === untilMs) continue;
    untilMs = effective;
    // A shortened cooldown may already be due; the loop then returns so the
    // caller's next attempt starts right away. Otherwise publish the new time.
    if (effective <= now()) return;
    publish(effective, false);
  }
}

/**
 * Run one call attempt under the shared retry policy. `run` performs a single
 * request and throws a {@link ModelError} on any failure.
 *
 * A genuine retryable upstream failure consumes the retry budget and waits the
 * exponential backoff, or an adopted hint's not-before instant. A local
 * admission refusal and a hint wait are recovery waits in the same loop: they
 * never replay after output started, a cancellation aborts any wait
 * immediately, and an admission refusal never spends an upstream retry. The
 * wait itself has no cumulative budget; it ends only when the real route state
 * allows the next attempt or when the caller aborts.
 */
export async function runWithRetry<T>(run: () => Promise<T>, context: RetryContext): Promise<T> {
  const random = context.random ?? Math.random;
  const now = context.now ?? Date.now;
  let attempt = 1;
  for (;;) {
    // A cancellation stops the loop before the route-health read and, below,
    // before the request itself.
    if (context.signal.aborted) throw abortError();
    // Re-read route health before every actual attempt — the initial one and
    // each one that follows a wait — so a route that entered (or extended) its
    // cooldown is waited out in the same loop instead of probed early and
    // rejected by the Gateway. One wait owner; no nested retry loop.
    const blockedUntil = context.preflight?.();
    if (blockedUntil !== undefined && blockedUntil > now()) {
      // No advertised floor here: this instant is live route state, so the wait
      // may be shortened as well as extended while it sleeps.
      await waitForRecovery({ attempt, kind: 'server', reason: 'admission', untilMs: blockedUntil }, context, now);
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
      const advertised = advertisedNotBeforeMs(failure, now);
      // Only a genuine upstream failure without an advertised instant falls
      // back to exponential backoff; an admission refusal never spins one.
      if (advertised === undefined && !admission) {
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
      // A missing, invalid or already-past instant is an unknown-time recovery
      // wait: it is published with no `retryAt` and slept with the abortable
      // minimum local recheck, so a past or absent time is never published as
      // an ETA and no upstream request is issued before the wait is over.
      const knownMs = advertised !== undefined && advertised > now() ? advertised : undefined;
      await waitForRecovery({
        attempt,
        kind: failure.kind,
        ...(failure.status === undefined ? {} : { status: failure.status }),
        reason: admission ? 'admission' : 'recovery',
        // A real upstream hint is a floor the refreshed route may only move
        // later; a refusal's own route state is refreshed freely. No floor is
        // kept for an unknown wait, so nothing obsolete blocks a shorter one.
        ...(admission || knownMs === undefined ? {} : { floorMs: knownMs }),
        untilMs: knownMs,
        // Only a hint that was actually adopted is reported; a pure backoff
        // decision carries no retryAfter.
        ...(failure.retryAfter === undefined ? {} : { retryAfter: failure.retryAfter }),
      }, context, now);
      // Only a real upstream try spends the retry budget; an admission refusal
      // waits without consuming one.
      if (!admission) attempt += 1;
    }
  }
}

/** Wait at most one timer-safe chunk, rejecting immediately when aborted. */
function waitChunk(ms: number, signal: AbortSignal): Promise<void> {
  return wait(Math.min(ms, MAX_TIMER_MS), signal);
}

/** Wait `ms`, rejecting immediately when the signal aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, Math.min(ms, MAX_TIMER_MS));
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
