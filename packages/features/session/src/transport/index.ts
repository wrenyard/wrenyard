/**
 * Session model transport: the one seam between the session application and the
 * local Gateway.
 *
 * It hides the three Gateway protocols (Chat Completions, Responses, Messages)
 * behind {@link ModelTransport}, picks the adapter from the Gateway model list's
 * per-model protocols (precedence Chat → Responses → Messages), and owns the
 * sole same-route retry. The application never sees an endpoint, a wire shape or
 * a retry decision.
 */
import type { WrenyardGatewayConnection } from '@wrenyard/control';
import { GATEWAY_HEADERS } from '@wrenyard/providers/base';

import {
  SESSION_PROTOCOLS,
  selectSessionProtocol,
  type AdapterEmit,
  type Completion,
  type GatewayEndpoints,
  type ModelRequest,
  type ModelResult,
  type ModelTransport,
  type ProtocolAdapter,
  type SessionProtocol,
} from './protocol.ts';
import { ModelError, abortError, httpError, networkError, normalizeStreamError } from './errors.ts';
import { runWithRetry } from './retry.ts';
import { chatAdapter, CHAT_REQUEST_MAX_BYTES } from './adapters/chat.ts';
import { responsesAdapter, RESPONSES_REQUEST_MAX_BYTES } from './adapters/responses.ts';
import { messagesAdapter, MESSAGES_REQUEST_MAX_BYTES } from './adapters/messages.ts';

export type { AdapterEmit, Completion, GatewayEndpoints, ProtocolAdapter } from './protocol.ts';
export {
  type FinishReason,
  type Message,
  type MessageToolCall,
  type ModelAttribution,
  type ModelAttempts,
  type ModelContentPart,
  type ModelEvent,
  type ModelRequest,
  type ModelResult,
  type ModelToolCall,
  type ModelTransport,
  type RetryAfterHint,
  type RetryAfterSource,
  type SessionProtocol,
  type ToolCall,
  type ToolChoice,
  type ToolSpec,
  type TpsSample,
  type Usage,
  parseToolArguments,
  record,
  numberField,
  stringField,
} from './protocol.ts';
export { SESSION_PROTOCOLS, selectSessionProtocol, supportsSession } from './protocol.ts';
export {
  type ModelErrorKind,
  type UpstreamErrorIdentity,
  ModelError,
  abortError,
  classifyOfficialError,
  classifyStatus,
  describeFailure,
  incompleteStreamError,
  isContextOverflowError,
  isModelError,
  isQuotaCode,
  normalizeStreamError,
  retryAfterHintFromHeaders,
  retryAfterMsFromHeaders,
  shouldRetryFromHeaders,
} from './errors.ts';
export { MAX_RETRIES, BASE_DELAY_MS, isRetryable, retryDelayMs, runWithRetry, type RetryDecision, type RetryContext } from './retry.ts';

const ADAPTERS: Readonly<Record<SessionProtocol, ProtocolAdapter>> = {
  openai_chat: chatAdapter,
  openai_responses: responsesAdapter,
  anthropic_messages: messagesAdapter,
};

/** Hard byte cap of one serialized request body for the chosen protocol. */
export const GATEWAY_REQUEST_MAX_BYTES = CHAT_REQUEST_MAX_BYTES;
export { CHAT_REQUEST_MAX_BYTES, RESPONSES_REQUEST_MAX_BYTES, MESSAGES_REQUEST_MAX_BYTES };

/** The session adapter for one known protocol, or `undefined` when unknown. */
export function adapterForProtocol(protocol: string): ProtocolAdapter | undefined {
  return (SESSION_PROTOCOLS as readonly string[]).includes(protocol)
    ? ADAPTERS[protocol as SessionProtocol]
    : undefined;
}

/** Resolves the current gateway connection; called lazily inside `complete`. */
export type GatewayConnectionSource = () => Promise<WrenyardGatewayConnection>;

export interface ModelTransportOptions {
  gateway: GatewayConnectionSource;
  /** Fetch implementation; defaults to the global.
   *
   * Deliberately not part of the protocol contract: it is a transport concern.
   */
  fetch?: typeof fetch;
}

/** Create the session model transport over a lazily-acquired gateway. */
export function createModelTransport(options: ModelTransportOptions): ModelTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return {
    async complete(request: ModelRequest): Promise<ModelResult> {
      if (!request.reasoningEffort) throw new ModelError('Model request requires reasoningEffort', { kind: 'invalid_request' });
      if (request.signal.aborted) throw new ModelError('Model request was aborted', { kind: 'aborted' });
      const connection = await options.gateway();
      const model = findModel(connection, request.model);
      if (!model) throw new ModelError(`Unknown gateway model: ${request.model}`, { kind: 'model_unavailable' });
      const protocol = selectSessionProtocol(model.protocols);
      if (protocol === undefined) throw new ModelError(`Model ${request.model} has no supported session protocol`, { kind: 'model_unavailable' });
      const adapter = ADAPTERS[protocol];

      const body = adapter.serialize(request);
      const actualBytes = Buffer.byteLength(body, 'utf8');
      if (actualBytes > adapter.maxBytes) throw new ModelError(`${adapter.label} exceeds ${adapter.maxBytes} bytes: ${actualBytes}`, { kind: 'invalid_request' });

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${connection.token}`,
        [GATEWAY_HEADERS.reasoningEffort]: request.reasoningEffort,
      };
      if (request.attribution?.role !== undefined) headers[GATEWAY_HEADERS.callRole] = request.attribution.role;
      if (request.attribution?.sessionId !== undefined) headers[GATEWAY_HEADERS.sessionId] = request.attribution.sessionId;

      const endpoints: GatewayEndpoints = {
        chat: connection.openaiChatBaseUrl,
        responses: connection.openaiResponsesBaseUrl,
        messages: connection.anthropicBaseUrl,
      };
      const url = adapter.url(endpoints);

      let outputStarted = false;
      const emit: AdapterEmit = {
        text: (delta) => { if (delta) outputStarted = true; request.onEvent?.({ type: 'text', delta }); },
        reasoning: (delta) => { if (delta) outputStarted = true; request.onEvent?.({ type: 'reasoning', delta }); },
        toolCall: (call) => { outputStarted = true; request.onEvent?.({ type: 'tool_call', call }); },
        usage: (usage) => request.onEvent?.({ type: 'usage', usage }),
        activity: () => request.onEvent?.({ type: 'activity' }),
        output: () => { outputStarted = true; },
      };

      // Count the requests actually issued, so a cancellation during a retry
      // wait is never reported as another request.
      let requests = 0;
      const startedMs = Date.now();
      const attempt = async (): Promise<Completion> => {
        if (request.signal.aborted) throw abortError();
        requests += 1;
        let response: Response;
        try {
          response = await fetchImpl(url, { method: 'POST', headers, body, signal: request.signal });
        } catch (error) {
          throw networkError(error, request.signal);
        }
        if (!response.ok) throw await httpError(response);
        try {
          return await adapter.read(response, request, emit);
        } catch (error) {
          throw normalizeStreamError(error, request.signal, outputStarted);
        }
      };

      try {
        const completion = await runWithRetry(attempt, {
          signal: request.signal,
          outputStarted: () => outputStarted,
          onRetry: (decision) => {
            request.onEvent?.({
              type: 'retry',
              attempt: decision.attempt,
              kind: decision.kind,
              ...(decision.status === undefined ? {} : { status: decision.status }),
              delayMs: decision.delayMs,
              ...(decision.retryAfter === undefined ? {} : { retryAfter: decision.retryAfter }),
            });
          },
        });
        // Only the final successful attempt returns a completion; a failed
        // attempt throws above and its samples are never exposed. The optional
        // tokenizer_v1 sample is carried onto the result unchanged.
        return {
          ...completion,
          ...(completion.tps === undefined ? {} : { tps: completion.tps }),
          attempts: { count: requests, totalMs: Date.now() - startedMs },
        };
      } catch (error) {
        const attempts = { count: requests, totalMs: Date.now() - startedMs };
        if (error instanceof ModelError) {
          throw new ModelError(error.message, {
            kind: error.kind,
            ...(error.status === undefined ? {} : { status: error.status }),
            ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
            ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
            ...(error.upstream === undefined ? {} : { upstream: error.upstream }),
            ...(error.shouldRetry === undefined ? {} : { shouldRetry: error.shouldRetry }),
            ...(error.outputStarted ? { outputStarted: true } : {}),
            attempts,
            cause: error,
          });
        }
        throw error;
      }
    },
  };
}

/** Resolve the Gateway model row for a `provider/model` public id. */
function findModel(connection: WrenyardGatewayConnection, publicId: string): WrenyardGatewayConnection['models'][number] | undefined {
  return connection.models.find((entry) => entry.publicId === publicId || `${entry.provider}/${entry.id}` === publicId);
}
