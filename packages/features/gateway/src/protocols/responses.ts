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

/** Emits the stable, distinct channel of one Responses generation delta. */
function emitText(sink: TpsSink, channel: string, value: unknown): void {
  if (typeof value === 'string' && value !== '') sink.delta(channel, value);
}

/**
 * The stable output-item identity of one Responses event, used to partition
 * text and function-argument channels: the item id when present, otherwise the
 * numeric output index.
 */
function itemKey(row: Record<string, unknown>): string {
  if (typeof row.item_id === 'string' && row.item_id !== '') return row.item_id;
  if (typeof row.output_index === 'number' && Number.isFinite(row.output_index)) return String(Math.trunc(row.output_index));
  return '0';
}

/** A finite numeric index as a stable channel fragment, defaulting to `0`. */
function indexKey(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.trunc(value)) : '0';
}

/**
 * OpenAI Responses differences: the `/v1/models` list shape, the `{error:{...}}`
 * envelope, the response `model` position (top level and inside `response`),
 * and usage / completion parsing.
 */
const adapter: UsageAdapter = {
  input: (raw) => count(raw.input_tokens),
  output: (raw) => count(raw.output_tokens),
  cachedInput: (raw) => count(object(raw.input_tokens_details)?.cached_tokens),
  reasoning: (raw) => count(object(raw.output_tokens_details)?.reasoning_tokens),
  usage: (row) => object(row.usage) ?? object(object(row.response)?.usage),
  terminal: (row) => row.type === 'response.completed' || object(row.response)?.status === 'completed',
  // Completion is always a JSON event, never a raw sentinel.
  sentinel: () => false,
  failure: (row) => {
    if (row.error !== undefined && row.error !== null) return true;
    if (row.type === 'error' || row.type === 'response.failed' || row.type === 'response.incomplete') return true;
    const response = object(row.response);
    if (!response) return false;
    return response.error !== undefined && response.error !== null
      || response.status === 'failed' || response.status === 'incomplete';
  },
  // The official in-stream error events are `error`, `response.failed` and
  // `response.incomplete`; their raw `type`/`code` are read for observation.
  // The frames themselves are never rewritten.
  errorIdentity: (row) => {
    if (row.error !== undefined && row.error !== null) return errorIdentityOf(row.error) ?? {};
    const nested = object(row.response)?.error;
    if (nested !== undefined && nested !== null) return errorIdentityOf(nested) ?? {};
    if (row.type === 'error' || row.type === 'response.failed' || row.type === 'response.incomplete') {
      return errorIdentityOf(row) ?? {};
    }
    return undefined;
  },
};

export const responsesProtocol: GatewayProtocolModule = {
  protocol: 'openai_responses',
  modelsPath: '/gateway/openai-responses/v1/models',
  inferencePath: '/gateway/openai-responses/v1/responses',

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
    const row = object(event);
    if (!row) return false;
    // The official in-stream error events are `error`, `response.failed` and
    // `response.incomplete`; a nested `response.error` object is also one.
    if (row.type === 'error' || row.type === 'response.failed' || row.type === 'response.incomplete') return true;
    if (object(object(row.response)?.error) !== undefined) return true;
    // An event carrying an `error` object (a `error:null` field is not an error).
    return object(row.error) !== undefined;
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
    if (!root) return;
    if (typeof root.model === 'string') root.model = toPublic(root.model);
    const nested = object(root.response);
    if (nested && typeof nested.model === 'string') nested.model = toPublic(nested.model);
  },

  // No protocol-fixed request field: the stream/store contract is supplier-owned.
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
        const response = object(row.response);
        if (response && typeof response.id === 'string' && response.id !== '') responseId = response.id;
        // The official in-stream error events are `error`, `response.failed` and
        // `response.incomplete`; unsuccessful termination produces no sample.
        if (row.type === 'error' || row.type === 'response.failed' || row.type === 'response.incomplete'
          || (row.error !== undefined && row.error !== null)
          || (response !== undefined && (response.error !== undefined && response.error !== null
            || response.status === 'failed' || response.status === 'incomplete'))) {
          sink.fail();
          return;
        }
        // Only the `*.delta` events are incremental generation; item snapshots
        // (`response.output_item.*`) and `*.done` events carry complete values
        // and are never counted. Every real delta is forwarded exactly once and
        // is never content-deduplicated.
        switch (row.type) {
          case 'response.completed':
            sink.complete(responseId === '' ? undefined : responseId);
            return;
          case 'response.output_text.delta':
            emitText(sink, `output_text:${itemKey(row)}:${indexKey(row.content_index)}`, row.delta);
            return;
          case 'response.reasoning_text.delta':
            emitText(sink, `reasoning_text:${itemKey(row)}`, row.delta);
            return;
          case 'response.reasoning_summary_text.delta':
            emitText(sink, `reasoning_summary:${itemKey(row)}:${indexKey(row.summary_index)}`, row.delta);
            return;
          case 'response.function_call_arguments.delta':
            emitText(sink, `tool:${itemKey(row)}`, row.delta);
            return;
        }
      },
    };
  },
};
