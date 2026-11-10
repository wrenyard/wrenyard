import type { UpstreamRouteErrorInput, UpstreamRouteFailure } from '../base/contracts.ts';
import { object, first, time } from '../base/quota-parsing.ts';

/** A reset instant stated in the message, e.g. `将在 2026-01-02 03:04:05 UTC+8 重置`. */
const MESSAGE_RESET_PATTERN = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*UTC([+-])(\d{1,2})(?::?(\d{2}))?[^\r\n]*?(?:重置|reset)/iu;

function messageReset(message: unknown): string | undefined {
  const reset = typeof message === 'string' ? MESSAGE_RESET_PATTERN.exec(message) : null;
  return reset === null ? undefined : time(`${reset[1]}T${reset[2]}${reset[3]}${reset[4]!.padStart(2, '0')}:${reset[5] ?? '00'}`);
}
/** Only explicit exhaustion/model codes establish a route defect; a bare per-model 429 stays route-scoped; no credit guesses. */
export function codeBuddyRouteFailure(input: UpstreamRouteErrorInput): UpstreamRouteFailure | undefined {
  const root = object(input.body);
  const error = object(root.error);
  const row = Object.keys(error).length ? error : root;
  const message = first(row, 'message', 'msg', 'error_message');
  const code = first(row, 'reason_code', 'code', 'type');
  const until = time(first(row, 'resets_at', 'reset_at', 'reset_time')) ?? messageReset(message);
  const quotaPoolId = first(row, 'quota_pool_id', 'quotaPoolId');
  if (typeof message === 'string' && (
    /service info not found/i.test(message)
    || /not in (?:the )?supported models/i.test(message)
    || (/model/i.test(message) && /not found/i.test(message))
  )) return { state: 'model_unavailable', scope: 'route' };
  if (code === 'quota_exhausted' || code === 'insufficient_quota') {
    return { state: 'quota_exhausted', scope: 'pool', ...(typeof quotaPoolId === 'string' ? { quotaPoolId } : {}), ...(until ? { until } : {}) };
  }
  if (code === 'insufficient_balance' || code === 'balance_exhausted') return { state: 'quota_exhausted', scope: 'provider', ...(until ? { until } : {}) };
  if (code === 'model_not_found' || code === 'model_unavailable') return { state: 'model_unavailable', scope: 'route', ...(until ? { until } : {}) };
  // A bare per-model 429 carries no account/pool exhaustion code, so it limits
  // only this exact route; a pool claim belongs to an explicit exhaustion code
  // or a named quota_pool_id below.
  if (input.status === 429 && code !== 'quota_exhausted' && code !== 'insufficient_quota' && code !== 'insufficient_balance' && code !== 'balance_exhausted' && typeof quotaPoolId !== 'string') {
    return { state: 'rate_limited', scope: 'route', ...(until ? { until } : {}) };
  }
  if (input.status === 429 && typeof quotaPoolId === 'string') return { state: 'rate_limited', scope: 'pool', quotaPoolId, ...(until ? { until } : {}) };
  return undefined;
}

/** Chat Completions code the Gateway's generic wrapper would use for a status. */
const STATUS_TYPES: Readonly<Record<number, string>> = {
  400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error',
  404: 'not_found_error', 408: 'timeout_error', 429: 'rate_limit_error',
};
const SERVER_TYPE = 'api_error';

/** Exhaustion codes whose official meaning is HTTP 429. */
const QUOTA_CODES: ReadonlySet<string> = new Set([
  'quota_exhausted', 'insufficient_quota', 'insufficient_balance', 'balance_exhausted',
]);
/** Codes whose official meaning is HTTP 404. */
const MODEL_CODES: ReadonlySet<string> = new Set(['model_not_found', 'model_unavailable']);

const envelope = (type: string, message: string, code?: string): Record<string, unknown> => ({
  error: { message, type, code: code ?? null, param: null },
});

/** Official Messages error shape: `{ type: 'error', error: { type, message } }`. */
const messagesEnvelope = (type: string, message: string): Record<string, unknown> => ({
  type: 'error',
  error: { type, message },
});

/** Status -> official Messages `error.type`, matching the gateway messages.ts conventions. */
const MESSAGES_STATUS_TYPES: Readonly<Record<number, string>> = {
  400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error',
  404: 'not_found_error', 408: 'timeout_error', 413: 'request_too_large',
  429: 'rate_limit_error', 503: 'overloaded_error',
};
const MESSAGES_SERVER_TYPE = 'api_error';

/** The message a private CodeBuddy error carries, or a status-derived fallback. */
function supplierMessage(row: Record<string, unknown>, status: number): string {
  const message = first(row, 'message', 'msg', 'error_message');
  if (typeof message === 'string' && message !== '') return message;
  return `CodeBuddy request failed (HTTP ${status})`;
}

/**
 * The minimal entry-protocol correction for a CodeBuddy error, applied only
 * where the supplier departs from the official Chat Completions contract:
 *
 * - known permanent quota exhaustion is normalized to the fixed official
 *   shape: HTTP 429 with the non-retryable `insufficient_quota` code, even
 *   when the supplier already used status 429, keeping the supplier wording;
 * - a model code that carries a status whose official meaning is 404 is
 *   restored to 404;
 * - a private, non-official structure is wrapped in the official envelope while
 *   keeping the supplier's status and wording.
 *
 * Anything already handled correctly by the official rules is returned as
 * `undefined` so the Gateway forwards the upstream bytes unchanged. No generic
 * error vocabulary is introduced here.
 */
export function codeBuddyProtocolError(input: { status: number; body: unknown; protocol?: string }): { status: number; body: Record<string, unknown> } | undefined {
  const root = object(input.body);
  const error = object(root.error);
  const row = Object.keys(error).length ? error : root;
  const code = first(row, 'reason_code', 'code', 'type');
  const official = error.message !== undefined || (typeof error.code === 'string' && error.code !== '');
  const type = STATUS_TYPES[input.status] ?? (input.status >= 500 ? SERVER_TYPE : 'invalid_request_error');
  const isMessages = input.protocol === 'anthropic_messages';

  // The official Messages envelope wraps the error in `{ type: 'error',
  // error: { type, message } }`; an official Messages body passes through
  // verbatim. Detection mirrors the gateway's messages.ts isOfficialErrorBody.
  const officialMessages = root.type === 'error' && Object.keys(error).length > 0;

  if (typeof code === 'string' && QUOTA_CODES.has(code)) {
    // Known permanent exhaustion is always restored to the fixed official
    // shape: HTTP 429 with the non-retryable `insufficient_quota` code, even
    // when the supplier already reported 429, keeping the supplier's wording.
    // A body that is already the official 429 `insufficient_quota` shape is
    // left to verbatim pass-through.
    if (input.status === 429 && code === 'insufficient_quota' && official) return undefined;
    return isMessages
      ? { status: 429, body: messagesEnvelope('rate_limit_error', supplierMessage(row as Record<string, unknown>, input.status)) }
      : { status: 429, body: envelope('rate_limit_error', supplierMessage(row as Record<string, unknown>, input.status), 'insufficient_quota') };
  }
  if (typeof code === 'string' && MODEL_CODES.has(code) && input.status !== 404) {
    return isMessages
      ? { status: 404, body: messagesEnvelope('not_found_error', supplierMessage(row as Record<string, unknown>, input.status)) }
      : { status: 404, body: envelope('not_found_error', supplierMessage(row as Record<string, unknown>, input.status), code) };
  }
  // An official envelope is left to the Gateway's verbatim pass-through.
  if (isMessages ? officialMessages : official) return undefined;
  // A private structure is wrapped onto the entry protocol's official shape.
  return {
    status: input.status,
    body: isMessages
      ? messagesEnvelope(
          MESSAGES_STATUS_TYPES[input.status] ?? (input.status >= 500 ? MESSAGES_SERVER_TYPE : 'invalid_request_error'),
          supplierMessage(row as Record<string, unknown>, input.status),
        )
      : envelope(type, supplierMessage(row as Record<string, unknown>, input.status), typeof code === 'string' ? code : undefined),
  };
}

