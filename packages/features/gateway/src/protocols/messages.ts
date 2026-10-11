import type { PublicGatewayModel } from '@wrenyard/providers/catalog';
import { ResponseUsageObserver, type UsageAdapter } from '../response-usage.ts';
import {
  count,
  errorIdentityOf,
  modelListEntry,
  object,
  stripReasoningFields,
  type GatewayProtocolModule,
  type ResponseObserver,
  type TpsSink,
  type TpsTranslator,
} from './types.ts';

/**
 * Emits one nonempty Messages delta on its stable, per-block channel. Each real
 * `content_block_delta` is forwarded exactly once and is never
 * content-deduplicated; a `content_block_start` snapshot and completed
 * arguments are not deltas and are never counted here.
 */
function emitMessagesDelta(delta: Record<string, unknown>, index: number, sink: TpsSink): void {
  switch (delta.type) {
    case 'text_delta': {
      const text = delta.text;
      if (typeof text === 'string' && text !== '') sink.delta(`text:${index}`, text);
      return;
    }
    case 'thinking_delta': {
      const text = delta.thinking;
      if (typeof text === 'string' && text !== '') sink.delta(`thinking:${index}`, text);
      return;
    }
    case 'input_json_delta': {
      const text = delta.partial_json;
      if (typeof text === 'string' && text !== '') sink.delta(`tool:${index}`, text);
      return;
    }
  }
}

/**
 * True when one Messages record reports a failure: an `error` type or a
 * non-null `error` field. The usage observer and the TPS translator share this
 * one condition.
 */
function isMessagesFailure(row: Record<string, unknown>): boolean {
  return row.type === 'error' || (row.error !== undefined && row.error !== null);
}

/**
 * Anthropic Messages differences: the `/v1/models` list shape, the
 * `{type:"error",error:{type,message}}` envelope, the response `model` position
 * (top level and inside `message`), and usage / completion parsing.
 */
const adapter: UsageAdapter = {
  // Total input: Anthropic's `input_tokens` excludes cached tokens, so the
  // total sums `input_tokens`, cache reads and cache writes; absent when none
  // of the three is present.
  input: (raw) => {
    const inputTokens = count(raw.input_tokens);
    const read = count(raw.cache_read_input_tokens);
    const created = count(raw.cache_creation_input_tokens);
    if (inputTokens === undefined && read === undefined && created === undefined) return undefined;
    return (inputTokens ?? 0) + (read ?? 0) + (created ?? 0);
  },
  output: (raw) => count(raw.output_tokens),
  // Cached input is the cache-read tokens only.
  cachedInput: (raw) => count(raw.cache_read_input_tokens),
  reasoning: (raw) => count(object(raw.output_tokens_details)?.reasoning_tokens),
  usage: (row) => object(row.usage) ?? object(object(row.message)?.usage),
  terminal: (row) => row.type === 'message_stop',
  // Completion is always a JSON event, never a raw sentinel.
  sentinel: () => false,
  failure: (row) => isMessagesFailure(row),
  // The official in-stream error event is `{type:"error",error:{type,message}}`.
  // Recognition requires string `error.type` and `error.message`; a frame that
  // does not match is not the official shape. The frame is never rewritten.
  errorIdentity: (row) => {
    if (row.type !== 'error') return undefined;
    const error = object(row.error);
    if (!error || typeof error.type !== 'string' || typeof error.message !== 'string') return undefined;
    return errorIdentityOf(error) ?? {};
  },
};

export const messagesProtocol: GatewayProtocolModule = {
  protocol: 'anthropic_messages',
  modelsPath: '/gateway/anthropic/v1/models',
  inferencePath: '/gateway/anthropic/v1/messages',

  listModels(models: PublicGatewayModel[]): unknown {
    const data = models.map(modelListEntry);
    return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
  },

  errorEnvelope(type, message) {
    return { type: 'error', error: { type, message } };
  },

  isOfficialErrorBody(body) {
    const root = object(body);
    return root?.type === 'error' && object(root.error) !== undefined;
  },

  isOfficialStreamError(event) {
    // The official Messages stream error requires string `error.type` and
    // `error.message`; anything else is not the official frame.
    const row = object(event);
    if (!row || row.type !== 'error') return false;
    const error = object(row.error);
    return error !== undefined && typeof error.type === 'string' && typeof error.message === 'string';
  },

  errorTypeForStatus(status) {
    // The Anthropic-protocol conventional type for a generated status.
    if (status === 400) return 'invalid_request_error';
    if (status === 401) return 'authentication_error';
    if (status === 403) return 'permission_error';
    if (status === 404) return 'not_found_error';
    if (status === 408) return 'timeout_error';
    if (status === 413) return 'request_too_large';
    if (status === 429) return 'rate_limit_error';
    if (status === 503) return 'overloaded_error';
    if (status >= 500) return 'api_error';
    return 'invalid_request_error';
  },

  normalizeResponseModel(payload, toPublic) {
    const root = object(payload);
    if (!root) return;
    if (typeof root.model === 'string') root.model = toPublic(root.model);
    const nested = object(root.message);
    if (nested && typeof nested.model === 'string') nested.model = toPublic(nested.model);
  },

  // No protocol-fixed request field for Messages.
  prepareRequest() {},

  stripReasoningFields,

  createObserver(): ResponseObserver {
    return new ResponseUsageObserver(adapter);
  },

  createTpsTranslator(): TpsTranslator {
    let responseId = '';
    return {
      translate(record, sink) {
        const row = object(record);
        if (!row) return;
        if (row.type === 'message_start') {
          const message = object(row.message);
          if (message && typeof message.id === 'string' && message.id !== '') responseId = message.id;
          return;
        }
        // The official in-stream error event is `{type:"error",error:{...}}`.
        if (isMessagesFailure(row)) { sink.fail(); return; }
        if (row.type === 'message_stop') { sink.complete(responseId === '' ? undefined : responseId); return; }
        if (row.type !== 'content_block_delta') return;
        const delta = object(row.delta);
        if (!delta) return;
        const index = typeof row.index === 'number' && Number.isFinite(row.index) ? Math.trunc(row.index) : 0;
        emitMessagesDelta(delta, index, sink);
      },
    };
  },
};
