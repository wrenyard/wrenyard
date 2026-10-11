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
 * Emits the stable, distinct generation channels of one Chat delta. Content and
 * each tool-argument block are partitioned by choice (and, for tool arguments,
 * by the call's stable tool index); the reasoning field is the protocol's
 * `reasoning_content` → `reasoning` → `reasoning_text` precedence carried on a
 * single reasoning channel. Every real delta is forwarded exactly once: wire
 * deltas are already incremental, so an exact repeat or a prefix-containing
 * value is a legitimate delta and is never content-deduplicated. A `message`
 * snapshot is not a generation delta and is never fed here.
 */
function emitChatDelta(delta: Record<string, unknown>, choiceIndex: number, sink: TpsSink): void {
  const content = delta.content;
  if (typeof content === 'string' && content !== '') sink.delta(`content:${choiceIndex}`, content);
  const reasoning = firstNonemptyString(delta, ['reasoning_content', 'reasoning', 'reasoning_text']);
  if (reasoning !== undefined) sink.delta(`reasoning:${choiceIndex}`, reasoning);
  if (!Array.isArray(delta.tool_calls)) return;
  for (const call of delta.tool_calls) {
    const item = object(call);
    const rawArgs = object(item?.function)?.arguments;
    if (typeof rawArgs !== 'string' || rawArgs === '') continue;
    const index = typeof item?.index === 'number' && Number.isFinite(item.index)
      ? Math.trunc(item.index)
      : typeof item?.id === 'string' && item.id !== '' ? item.id : 0;
    sink.delta(`tool:${choiceIndex}:${index}`, rawArgs);
  }
}

/** The first nonempty string among `fields`, in order; the protocol's precedence. */
function firstNonemptyString(source: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = source[field];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * OpenAI Chat Completions differences: the `/v1/models` list shape, the
 * `{error:{...}}` envelope, the response `model` position, the
 * `stream_options.include_usage` contract, and usage / completion parsing.
 */
const adapter: UsageAdapter = {
  input: (raw) => count(raw.prompt_tokens),
  output: (raw) => count(raw.completion_tokens),
  cachedInput: (raw) => count(object(raw.prompt_tokens_details)?.cached_tokens),
  reasoning: (raw) => count(object(raw.completion_tokens_details)?.reasoning_tokens),
  usage: (row) => object(row.usage),
  // The protocol's successful completion is the SSE `[DONE]` sentinel alone.
  // A `finish_reason` (including `stop`) is metadata, not completion, so a
  // stream truncated before `[DONE]` is never treated as successful here.
  terminal: () => false,
  sentinel: (payload) => payload === '[DONE]',
  failure: (row) => {
    if (row.error !== undefined && row.error !== null) return true;
    return Array.isArray(row.choices) && row.choices.some((choice) => {
      const reason = object(choice)?.finish_reason;
      return reason === 'error' || reason === 'content_filter';
    });
  },
  // The official Chat error frame is `{"error":{...}}`; its `type`/`code` are
  // read for observation. The frame is never rewritten.
  errorIdentity: (row) => (row.error !== undefined && row.error !== null
    ? errorIdentityOf(row.error) ?? {}
    : undefined),
};

export const chatProtocol: GatewayProtocolModule = {
  protocol: 'openai_chat',
  modelsPath: '/gateway/openai-chat/v1/models',
  inferencePath: '/gateway/openai-chat/v1/chat/completions',

  listModels(models: PublicGatewayModel[]): unknown {
    return { object: 'list', data: models.map(modelListEntry) };
  },

  errorEnvelope(type, message) {
    // The complete official OpenAI error envelope: `code` and `param` are
    // always present and null when this Gateway has no value for them.
    return { error: { message, type, code: null, param: null } };
  },

  isOfficialErrorBody(body) {
    // The official shape is `{error:{message,...}}`; only the mandatory
    // `message` is required, so an upstream body that omits the optional
    // `type`/`code`/`param` is still recognized and passed through verbatim.
    const error = object(object(body)?.error);
    return error !== undefined && typeof error.message === 'string';
  },

  isOfficialStreamError(event) {
    // The Chat stream error frame is the same `{error:{...}}` shape.
    const error = object(object(event)?.error);
    return error !== undefined && typeof error.message === 'string';
  },

  errorTypeForStatus(status) {
    // The OpenAI-protocol conventional type for a generated status.
    if (status === 401) return 'authentication_error';
    if (status === 403) return 'permission_error';
    if (status === 404) return 'not_found_error';
    if (status === 408) return 'timeout_error';
    if (status === 429) return 'rate_limit_error';
    if (status >= 500) return 'server_error';
    return 'invalid_request_error';
  },

  normalizeResponseModel(payload, toPublic) {
    const root = object(payload);
    if (root && typeof root.model === 'string') root.model = toPublic(root.model);
  },

  prepareRequest(body) {
    // Chat streaming requests must report final usage so clients keep receiving
    // the provider's official billing numbers. Speed sampling no longer depends
    // on it. The flag is added only for streamed requests; every other field is
    // preserved exactly and no token values are invented.
    if (body.stream !== true) return;
    body.stream_options = { ...object(body.stream_options), include_usage: true };
  },

  stripReasoningFields,

  createObserver(): ResponseObserver {
    return new ResponseUsageObserver(adapter);
  },

  createTpsTranslator(): TpsTranslator {
    let responseId = '';
    return {
      translate(record, sink) {
        // The protocol's success marker is the SSE `[DONE]` sentinel.
        if (record === '[DONE]') {
          sink.complete(responseId === '' ? undefined : responseId);
          return;
        }
        const row = object(record);
        if (!row) return;
        if (typeof row.id === 'string' && row.id !== '') responseId = row.id;
        // The official Chat error frame is `{"error":{...}}`.
        if (row.error !== undefined && row.error !== null) { sink.fail(); return; }
        if (!Array.isArray(row.choices)) return;
        row.choices.forEach((choice, position) => {
          const item = object(choice);
          if (!item) return;
          const finish = item.finish_reason;
          if (finish === 'error' || finish === 'content_filter') { sink.fail(); return; }
          // Only a real `delta` is streamed generation; a `message` snapshot is
          // not a generation delta and is never counted.
          const delta = object(item.delta);
          if (!delta) return;
          const choiceIndex = typeof item.index === 'number' && Number.isFinite(item.index)
            ? Math.trunc(item.index)
            : position;
          emitChatDelta(delta, choiceIndex, sink);
        });
      },
    };
  },
};
