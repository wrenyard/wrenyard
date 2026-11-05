/**
 * Session model transport: the one seam between the session application and the
 * local Gateway.
 *
 * It hides the three Gateway protocols (Chat Completions, Responses, Messages)
 * behind {@link ModelTransport}, picks the adapter from the Gateway model list's
 * per-model protocols (precedence Chat → Responses → Messages), and issues one
 * upstream request per call. The application never sees an endpoint or a wire shape.
 */
import { TpsGenerationCollector } from '@wrenyard/metrics';
import type { GatewayConnection as WrenyardGatewayConnection } from '@wrenyard/protocol/gateway';

import {
  SESSION_PROTOCOLS,
  selectSessionProtocol,
  type AdapterEmit,
  type Completion,
  type GatewayEndpoints,
  type ModelAttempt,
  type ModelMetrics,
  type ModelRequest,
  type ModelResult,
  type ModelTransport,
  type ProtocolAdapter,
  type RetryAfterHint,
  type SessionProtocol,
  type Usage,
} from './protocol.ts';
import { ModelError, abortError, httpError, networkError, normalizeStreamError } from './errors.ts';
import { chatAdapter, CHAT_REQUEST_MAX_BYTES } from './adapters/chat.ts';
import { responsesAdapter, RESPONSES_REQUEST_MAX_BYTES } from './adapters/responses.ts';
import { messagesAdapter, MESSAGES_REQUEST_MAX_BYTES } from './adapters/messages.ts';

export type { AdapterEmit, Completion, GatewayEndpoints, ProtocolAdapter } from './protocol.ts';
export {
  type FinishReason,
  type Message,
  type MessageToolCall,
  type ModelAttempt,
  type ModelContentPart,
  type ModelEvent,
  type ModelMetrics,
  type ModelRequest,
  type ModelResult,
  type ModelToolCall,
  type ModelTransport,
  type ModelWaitReason,
  type RetryAfterHint,
  type RetryAfterSource,
  type SessionProtocol,
  type ToolCall,
  type ToolChoice,
  type ToolSpec,
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

const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_FIRST_RESPONSE_TIMEOUT_SEC = 120;

/** A failed call that produced no first content within the local deadline. */
function firstResponseTimeoutError(): ModelError {
  return new ModelError('Model request timed out waiting for the first response', { kind: 'server' });
}

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
      // The endpoint lists each model by its provider-qualified public id and
      // the request sends that exact identity, with no private provider header.
      const model = connection.models.find((entry) => entry.publicId === request.model);
      if (!model) throw new ModelError(`Unknown gateway model: ${request.model}`, { kind: 'model_unavailable' });
      const protocol = selectSessionProtocol(model.protocols);
      if (protocol === undefined) throw new ModelError(`Model ${request.model} has no supported session protocol`, { kind: 'model_unavailable' });
      const adapter = ADAPTERS[protocol];

      // The serialized body names exactly the id the endpoint lists; the
      // Gateway resolves its provider from that qualified identity.
      const body = adapter.serialize({ ...request, model: model.publicId });
      const actualBytes = Buffer.byteLength(body, 'utf8');
      if (actualBytes > adapter.maxBytes) throw new ModelError(`${adapter.label} exceeds ${adapter.maxBytes} bytes: ${actualBytes}`, { kind: 'invalid_request' });

      // Gateway authentication follows the selected protocol: the Anthropic
      // Messages entry authenticates with the official `x-api-key` header (plus
      // the required protocol version), while both OpenAI protocols keep Bearer.
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(protocol === 'anthropic_messages'
          ? { 'x-api-key': connection.token, 'anthropic-version': '2023-06-01' }
          : { authorization: `Bearer ${connection.token}` }),
      };

      const endpoints: GatewayEndpoints = {
        chat: connection.openaiChatBaseUrl,
        responses: connection.openaiResponsesBaseUrl,
        messages: connection.anthropicBaseUrl,
      };
      const url = adapter.url(endpoints);

      // The transport owns the first-response deadline locally. The abort is
      // internal, so an external cancellation still keeps its own identity.
      const timeoutSeconds = request.firstResponseTimeoutSec !== undefined
        && Number.isFinite(request.firstResponseTimeoutSec)
        && request.firstResponseTimeoutSec > 0
        ? request.firstResponseTimeoutSec
        : DEFAULT_FIRST_RESPONSE_TIMEOUT_SEC;
      const controller = new AbortController();
      const onExternalAbort = (): void => controller.abort();
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener('abort', onExternalAbort, { once: true });
      let timedOut = false;
      let firstResponseTimer: ReturnType<typeof setTimeout> | undefined;
      const armFirstResponseTimer = (): void => {
        if (firstResponseTimer !== undefined) return;
        firstResponseTimer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, Math.min(timeoutSeconds * 1000, MAX_TIMER_MS));
        firstResponseTimer.unref?.();
      };
      const clearFirstResponseTimer = (): void => {
        if (firstResponseTimer === undefined) return;
        clearTimeout(firstResponseTimer);
        firstResponseTimer = undefined;
      };

      let outputStarted = false;
      /** First time any content of this call was produced; shared with the metrics. */
      let firstOutputMs: number | undefined;
      /** Latest usage the stream actually reported, kept for a failed call. */
      let lastUsage: Usage | undefined;
      const markFirstOutput = (): void => { firstOutputMs ??= Date.now(); clearFirstResponseTimer(); };
      // One speed sampler per attempt: the transport owns speed collection, so an
      // adapter never references it. The adapter reports real streamed generation
      // deltas and the protocol's success/failure through `emit`.
      let tps = new TpsGenerationCollector();
      const emit: AdapterEmit = {
        text: (delta) => { if (delta) { outputStarted = true; markFirstOutput(); } request.onEvent?.({ type: 'text', delta }); },
        reasoning: (delta) => { if (delta) { outputStarted = true; markFirstOutput(); } request.onEvent?.({ type: 'reasoning', delta }); },
        toolCall: (call) => { outputStarted = true; markFirstOutput(); request.onEvent?.({ type: 'tool_call', call }); },
        usage: (usage) => { lastUsage = usage; request.onEvent?.({ type: 'usage', usage }); },
        activity: () => request.onEvent?.({ type: 'activity' }),
        output: () => { outputStarted = true; markFirstOutput(); },
        generation: (channel, delta) => tps.observe(channel, delta, Date.now()),
        complete: () => tps.complete(),
        fail: () => tps.fail(),
      };

      // Every request actually issued, in order, with its own duration and wait.
      const attempts: ModelAttempt[] = [];
      const startedMs = Date.now();
      const attempt = async (): Promise<{ completion: Completion; sample?: { outputTokens: number; windowMs: number } }> => {
        if (request.signal.aborted) throw abortError();
        const attemptStartMs = Date.now();
        tps = new TpsGenerationCollector();
        try {
          let response: Response;
          try {
            armFirstResponseTimer();
            response = await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal });
          } catch (error) {
            if (timedOut) throw firstResponseTimeoutError();
            throw networkError(error, request.signal);
          }
          if (!response.ok) {
            clearFirstResponseTimer();
            throw await httpError(response);
          }
          // The transport always requests a stream, so a successful response that
          // is not an SSE stream is a protocol failure, never a JSON completion.
          const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
          if (!contentType.includes('text/event-stream')) {
            clearFirstResponseTimer();
            throw new ModelError('Model gateway returned a non-streaming response where a text/event-stream stream was required', { kind: 'protocol' });
          }
          let completion: Completion;
          try {
            completion = await adapter.read(response, { ...request, signal: controller.signal }, emit);
          } catch (error) {
            if (timedOut) throw firstResponseTimeoutError();
            throw normalizeStreamError(error, request.signal, outputStarted);
          }
          clearFirstResponseTimer();
          attempts.push({ status: 200, ms: Date.now() - attemptStartMs, model: request.model });
          // Only a successfully completed stream yields a sample; the sampler
          // produces nothing for a failed, cancelled or truncated attempt.
          const sample = tps.sample();
          return sample === undefined ? { completion } : { completion, sample: { outputTokens: sample.outputTokens, windowMs: sample.windowMs } };
        } catch (error) {
          clearFirstResponseTimer();
          if (!(error instanceof ModelError)) throw error;
          // One request record per attempt. When an upstream retry hint was
          // adopted, the instant it points at is carried as `routeUntil` so the
          // ledger's `retryAt` projection can surface it; `model` keeps the route
          // identity of the attempt.
          const record: ModelAttempt = {
            ...(error.status === undefined ? {} : { status: error.status }),
            error: error.kind,
            ms: Date.now() - attemptStartMs,
            model: request.model,
            ...(error.retryAfterMs === undefined ? {} : { routeUntil: new Date(Date.now() + error.retryAfterMs).toISOString() }),
          };
          attempts.push(record);
          throw error;
        }
      };

      try {
        const { completion, sample } = await attempt();
        // Only the final successful attempt returns a completion; a failed
        // attempt throws above and its samples are never exposed.
        return {
          ...completion,
          metrics: {
            ...(completion.finishReason === undefined ? {} : { finishReason: completion.finishReason }),
            ...(completion.usage === undefined ? {} : { usage: completion.usage }),
            ...(firstOutputMs === undefined ? {} : { ttftMs: firstOutputMs - startedMs }),
            ...(sample === undefined ? {} : { streamMs: sample.windowMs, streamTokens: sample.outputTokens }),
            attempts,
          },
        };
      } catch (error) {
        if (error instanceof ModelError) {
          const metrics: ModelMetrics = {
            ...(lastUsage === undefined ? {} : { usage: lastUsage }),
            attempts,
          };
          throw new ModelError(error.message, {
            kind: error.kind,
            ...(error.status === undefined ? {} : { status: error.status }),
            ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
            ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
            ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
            ...(error.upstream === undefined ? {} : { upstream: error.upstream }),
            ...(error.shouldRetry === undefined ? {} : { shouldRetry: error.shouldRetry }),
            ...(error.outputStarted ? { outputStarted: true } : {}),
            metrics,
            cause: error,
          });
        }
        throw error;
      } finally {
        clearFirstResponseTimer();
        request.signal.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}
