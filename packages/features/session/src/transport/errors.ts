/**
 * Normalized session transport errors.
 *
 * Every adapter folds an HTTP failure, a stream failure or a connection failure
 * into one {@link ModelError} carrying the normalized `kind`, the HTTP `status`
 * when there was one, the supplier's original `message` and, when observable,
 * the supplier's own `{type, code}`. No provider-specific error vocabulary is
 * defined here: the Gateway already presents the entry protocol's official
 * shape, so classification reads only the protocol's own status codes and
 * official error codes.
 */
import { GATEWAY_HEADERS, parseAdmissionRefusal } from '@wrenyard/providers/base';

import { record, stringField, type ModelFailureSource, type ModelMetrics, type RetryAfterHint } from './protocol.ts';

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

/** The supplier's original error identity, kept for diagnostics. */
export interface UpstreamErrorIdentity {
  type?: string;
  code?: string;
}

/** Options for a {@link ModelError}. */
export interface ModelErrorOptions {
  kind: ModelErrorKind;
  status?: number;
  /** Supplied only when the upstream gave a usable hint (any length). */
  retryAfterMs?: number;
  /** The adopted upstream hint, kept with its original header value. */
  retryAfter?: RetryAfterHint;
  /**
   * Where the failure originated. Absent means an upstream fault; `admission`
   * means the local Gateway circuit refused the request without calling
   * upstream, so the upstream retry count must not be consumed.
   */
  source?: ModelFailureSource;
  /**
   * The absolute earliest instant (ISO 8601) the failed call may be retried:
   * the local admission refusal's probe time, or an adopted recoverable wait.
   * Set on a terminal bounded-wait failure so the caller reports `retryAt`.
   */
  retryAt?: string;
  upstream?: UpstreamErrorIdentity;
  /** Measured facts of the failed call, when the transport produced them. */
  metrics?: ModelMetrics;
  /** True when the failure happened after output had already started. */
  outputStarted?: boolean;
  /** Explicit retryability override from an upstream `x-should-retry` header. */
  shouldRetry?: boolean;
  cause?: unknown;
}

/** The one normalized transport failure. */
export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly retryAfter?: RetryAfterHint;
  readonly source?: ModelFailureSource;
  readonly retryAt?: string;
  readonly upstream?: UpstreamErrorIdentity;
  readonly metrics?: ModelMetrics;
  readonly outputStarted: boolean;
  readonly shouldRetry?: boolean;

  constructor(message: string, options: ModelErrorOptions) {
    super(message);
    this.name = 'ModelError';
    this.kind = options.kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
    if (options.source !== undefined) this.source = options.source;
    if (options.retryAt !== undefined) this.retryAt = options.retryAt;
    if (options.upstream !== undefined && (options.upstream.type !== undefined || options.upstream.code !== undefined)) {
      this.upstream = options.upstream;
    }
    if (options.metrics !== undefined) this.metrics = options.metrics;
    this.outputStarted = options.outputStarted ?? false;
    if (options.shouldRetry !== undefined) this.shouldRetry = options.shouldRetry;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** True when a value is a normalized transport error. */
export function isModelError(error: unknown): error is ModelError {
  return error instanceof ModelError;
}

/** Message excerpt cap, so a non-2xx supplier body stays readable. */
const ERROR_EXCERPT_CHARS = 2_000;

/** Classify a non-2xx HTTP status into a normalized kind. */
export function classifyStatus(status: number, code?: string): ModelErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_unavailable';
  if (status === 408) return 'network';
  if (status === 409) return 'invalid_request';
  if (status === 429) return isQuotaCode(code) ? 'quota_exhausted' : 'rate_limited';
  if (status === 400 || status === 422) return 'invalid_request';
  if (status >= 500) return 'server';
  return 'invalid_request';
}

/** True when an official error code reports an exhausted account quota. */
export function isQuotaCode(code: string | undefined): boolean {
  return code === 'insufficient_quota';
}

/** Official error `type`/`code` spellings mapped to the equivalent status semantics. */
const OFFICIAL_ERROR_KINDS: Readonly<Record<string, ModelErrorKind>> = {
  overloaded_error: 'server',
  engine_overloaded_error: 'server',
  server_error: 'server',
  api_error: 'server',
  rate_limit_error: 'rate_limited',
  rate_limit_exceeded: 'rate_limited',
  authentication_error: 'auth',
  invalid_api_key: 'auth',
  permission_error: 'auth',
  not_found_error: 'model_unavailable',
  model_not_found: 'model_unavailable',
  invalid_request_error: 'invalid_request',
  invalid_request: 'invalid_request',
  context_length_exceeded: 'context_overflow',
};

/**
 * Classify an official in-stream error frame by its own `type`/`code` into the
 * equivalent status semantics, so an official overload or rate-limit frame
 * before output is retryable and an invalid-request frame is not. A type
 * outside the official list is `protocol`, which is never retried.
 */
export function classifyOfficialError(type: string | undefined, code: string | undefined): ModelErrorKind {
  if (isQuotaCode(code)) return 'quota_exhausted';
  for (const value of [type, code]) {
    if (value === undefined) continue;
    const kind = OFFICIAL_ERROR_KINDS[value.toLowerCase()];
    if (kind !== undefined) return kind;
  }
  return 'protocol';
}

/**
 * Extract the official `{type, code}` of an entry-protocol error body, whether
 * it is the Chat/Responses envelope or the Messages envelope.
 */
export function upstreamErrorIdentity(body: unknown): UpstreamErrorIdentity {
  const root = record(body);
  if (!root) return {};
  const error = record(root.error) ?? root;
  return {
    ...(stringField(error.type) === undefined ? {} : { type: stringField(error.type)! }),
    ...(stringField(error.code) === undefined ? {} : { code: stringField(error.code)! }),
  };
}

/** Human-readable message of a streamed error frame or supplier error object. */
export function describeFailure(failure: unknown, fallback: string): string {
  if (typeof failure === 'string' && failure !== '') return failure;
  const value = record(failure)?.message;
  if (typeof value === 'string' && value !== '') return value;
  return fallback;
}

/**
 * Parse `retry-after-ms` and `retry-after` from response headers. A valid hint
 * is adopted at any length, including values above a minute: seconds, an HTTP
 * date, or milliseconds are all accepted and kept as an absolute not-before
 * instant, so the caller never retries before the advertised time. A missing or
 * invalid header yields no hint; a hint that resolves to a past or zero instant
 * is floored to a bounded minimum delay so the caller never spins.
 *
 * A syntactically numeric value that overflows to positive infinity is kept as
 * a conservatively beyond-budget delay rather than treated as a 1-second hint or
 * dropped to the exponential-backoff path, and no adopted instant may exceed the
 * representable `Date` range, so an extreme hint can never produce an invalid
 * `Date` or a `RangeError`.
 */
export function retryAfterHintFromHeaders(headers: Headers): RetryAfterHint | undefined {
  const rawMs = headers.get('retry-after-ms');
  // An empty header value is not the number zero; reject it instead of parsing
  // the empty string as a zero delay.
  if (rawMs !== null && rawMs.trim() !== '') {
    const ms = Number(rawMs.trim());
    if (Number.isFinite(ms) && ms >= 0) return hint('retry-after-ms', rawMs, ms);
    // A syntactically numeric value that overflowed to positive infinity is a
    // conservatively beyond-budget delay, never a 1-second one.
    if (ms === Number.POSITIVE_INFINITY) return hint('retry-after-ms', rawMs, ms);
  }
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return hint('retry-after', raw, seconds * 1_000);
  // The same for a seconds value whose own string overflowed to infinity; a
  // finite seconds value whose millisecond product overflows is normalized by
  // `hint` below.
  if (seconds === Number.POSITIVE_INFINITY) return hint('retry-after', raw, seconds);
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return hint('retry-after', raw, date - Date.now());
  return undefined;
}

/** The adopted upstream retry hint's applied delay, when there is one. */
export function retryAfterMsFromHeaders(headers: Headers): number | undefined {
  return retryAfterHintFromHeaders(headers)?.delayMs;
}

/** Bounded floor for an adopted hint so a past or missing instant never spins. */
export const RETRY_AFTER_MIN_MS = 1_000;

/** The largest instant a `Date` can represent (epoch ms). */
const MAX_TIME_MS = 8_640_000_000_000_000;

/**
 * Headroom kept below {@link MAX_TIME_MS} when clamping an adopted hint's
 * absolute instant, so a later `epoch + delayMs` read (the attempt record's
 * `routeUntil`) still lands on a valid `Date`. One day is far more than any read
 * needs and still leaves the instant astronomically beyond any recovery budget,
 * so a conservatively beyond-budget hint stays beyond budget.
 */
const HINT_CEILING_HEADROOM_MS = 86_400_000;

function hint(source: RetryAfterHint['source'], value: string, requestedMs: number): RetryAfterHint {
  const now = Date.now();
  const ceiling = MAX_TIME_MS - HINT_CEILING_HEADROOM_MS;
  const capped = Math.min(now + normalizedHintDelay(requestedMs), ceiling);
  const delayMs = Math.max(RETRY_AFTER_MIN_MS, Math.round(capped) - now);
  return { source, value, delayMs, retryAt: now + delayMs };
}

/**
 * Turn a parsed hint value into a finite, non-negative millisecond delay. A
 * positive overflow — a syntactically numeric value too large for a finite
 * number, or an infinity — stays at infinity so `hint` caps the instant at the
 * representable ceiling instead of collapsing it to a 1-second hint. A `NaN` or
 * negative overflow yields zero, so the caller's bounded minimum floor still
 * applies and the wait never spins.
 */
function normalizedHintDelay(requestedMs: number): number {
  if (!Number.isFinite(requestedMs)) return requestedMs > 0 ? Number.POSITIVE_INFINITY : 0;
  return Math.max(0, requestedMs);
}

/** Read the `x-should-retry` hint, when the upstream supplied it. */
export function shouldRetryFromHeaders(headers: Headers): boolean | undefined {
  const raw = headers.get('x-should-retry')?.trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

/**
 * Build a {@link ModelError} for a non-2xx response. The message keeps the
 * supplier's wording; the status, official identity and retry hints are kept
 * for classification and for the `gateway.request.completed` event.
 *
 * Only the Gateway's own `x-wrenyard-admission` header is read to mark a local
 * admission refusal: it is a structured, Gateway-local marker, never an echoed
 * upstream header, so a real upstream 503 stays an ordinary `upstream` failure.
 */
export async function httpError(response: Response): Promise<ModelError> {
  const text = (await response.text().catch(() => '')).trim();
  let body: unknown;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  const identity = upstreamErrorIdentity(body);
  // The official envelope nests the supplier's message under `error`; report it
  // verbatim instead of falling back to the raw body text.
  const supplier = describeFailure(record(body)?.error, '') || describeFailure(body, '');
  const excerpt = supplier !== '' ? supplier : text.slice(0, ERROR_EXCERPT_CHARS);
  const message = excerpt !== '' ? excerpt : `Model request failed (HTTP ${response.status})`;
  const retryAfter = retryAfterHintFromHeaders(response.headers);
  const shouldRetry = shouldRetryFromHeaders(response.headers);
  const admission = parseAdmissionRefusal(response.headers.get(GATEWAY_HEADERS.admission));
  // A local admission refusal carries the absolute probe instant and takes
  // precedence over any upstream hint. Without a refusal, a genuine upstream
  // hint still supplies the absolute `retryAt`, so an exhausted upstream retry
  // budget keeps the recovery instant for the caller instead of dropping it.
  const retryAt = admission !== undefined
    ? admission.retryAt
    : retryAfter === undefined
      ? undefined
      : new Date(retryAfter.retryAt).toISOString();
  return new ModelError(message, {
    // An official context-overflow code decides before the status, so a 400
    // carrying `context_length_exceeded` still classifies as context overflow.
    kind: identity.code === 'context_length_exceeded'
      ? 'context_overflow'
      : classifyStatus(response.status, identity.code),
    status: response.status,
    // A local admission refusal is marked as such, so the retry loop never
    // spends an upstream retry on it.
    ...(admission === undefined ? {} : { source: 'admission' as const }),
    ...(retryAt === undefined ? {} : { retryAt }),
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter.delayMs, retryAfter }),
    upstream: identity,
    ...(shouldRetry === undefined ? {} : { shouldRetry }),
  });
}

/** A stream failure observed inside a 200 response. */
export function streamError(options: {
  kind: ModelErrorKind;
  message: string;
  upstream?: UpstreamErrorIdentity;
  outputStarted?: boolean;
  /**
   * The response headers of the stream, so an official in-stream error keeps
   * the upstream `retry-after`/`retry-after-ms` and `x-should-retry` hints. The
   * abort and post-output boundaries still decide retryability.
   */
  headers?: Headers;
}): ModelError {
  const retryAfter = options.headers === undefined ? undefined : retryAfterHintFromHeaders(options.headers);
  const shouldRetry = options.headers === undefined ? undefined : shouldRetryFromHeaders(options.headers);
  return new ModelError(options.message, {
    kind: options.outputStarted === true ? 'interrupted' : options.kind,
    ...(options.upstream === undefined ? {} : { upstream: options.upstream }),
    ...(options.outputStarted === true ? { outputStarted: true } : {}),
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter.delayMs, retryAfter }),
    ...(shouldRetry === undefined ? {} : { shouldRetry }),
  });
}

/** A connection failure before any response arrived. */
export function networkError(error: unknown, signal: AbortSignal): ModelError {
  if (signal.aborted || isAbortError(error)) return abortError();
  return new ModelError(messageOf(error), { kind: 'network', cause: error });
}

/** Preserve an abort as an abort; rewrite anything else into a normalized error. */
export function normalizeStreamError(error: unknown, signal: AbortSignal, outputStarted: boolean): ModelError {
  // A cancellation always wins, even over an already-normalized error.
  if (signal.aborted || isAbortError(error)) return abortError();
  if (error instanceof ModelError) {
    if (outputStarted && error.kind !== 'aborted' && !error.outputStarted) {
      return new ModelError(error.message, {
        kind: 'interrupted', ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.upstream === undefined ? {} : { upstream: error.upstream }), outputStarted: true,
        // The origin and not-before instant survive the rewrite whether the
        // failure stays an upstream one or is a local admission refusal.
        ...(error.source === undefined ? {} : { source: error.source }),
        ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
      });
    }
    return error;
  }
  return new ModelError(messageOf(error), { kind: outputStarted ? 'interrupted' : 'protocol', ...(outputStarted ? { outputStarted: true } : {}) });
}

/**
 * A stream that ended (or a connection that dropped) before the protocol's
 * completion marker. It is built as a retryable `network` failure; the transport
 * rewrites it to `interrupted` once output has started, so a truncated stream is
 * never silently accepted and never replayed after output.
 */
export function incompleteStreamError(): ModelError {
  return new ModelError('Model stream ended before the reply was complete', { kind: 'network' });
}

/** An aborted call. */
export function abortError(): ModelError {
  return new ModelError('Model request was aborted', { kind: 'aborted' });
}

/** True when a value is an abort error. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Human-readable message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Phrases upstream providers use when a request exceeds their context window.
 * The Gateway forwards the provider body, so a small set of stable phrases is
 * matched after the official code check.
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context[_ ]length/iu,
  /context window/iu,
  /maximum context/iu,
  /context overflow/iu,
  /exceeds? the (?:maximum )?context/iu,
  /(?:prompt|input|request|messages?)[^.\n]*too (?:long|large)/iu,
  /too many tokens/iu,
  /reduce the length of the messages?/iu,
];

/**
 * True when a failure is an upstream context-window overflow. `calls.ts` uses
 * this to prefix the `call` event error with `context_overflow:` so Desktop can
 * classify the failed turn without parsing provider wording.
 */
export function isContextOverflowError(error: unknown): boolean {
  if (error instanceof ModelError && error.kind === 'context_overflow') return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (message === '') return false;
  if (message.startsWith('context_overflow:')) return true;
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}
