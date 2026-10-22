/**
 * Session model transport: the one seam between the session application and the
 * local Gateway.
 *
 * It hides the three Gateway protocols (Chat Completions, Responses, Messages)
 * behind {@link ModelTransport}, picks the adapter from the Gateway model list's
 * per-model protocols (precedence Chat → Responses → Messages), and issues one
 * upstream request per call. The application never sees an endpoint or a wire shape.
 */
import { TpsGenerationCollector } from '@wrenyard/agent-client/statistics';
import type { GatewayConnection as WrenyardGatewayConnection } from '@wrenyard/protocol/gateway';
import { GATEWAY_HEADERS } from '@wrenyard/providers/base';

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
import type { ModelEvent, ModelPreflightResult } from './protocol.ts';
import { chatAdapter, CHAT_REQUEST_MAX_BYTES } from './adapters/chat.ts';
import { responsesAdapter, RESPONSES_REQUEST_MAX_BYTES } from './adapters/responses.ts';
import { messagesAdapter, MESSAGES_REQUEST_MAX_BYTES } from './adapters/messages.ts';

export type { AdapterEmit, Completion, GatewayEndpoints, ProtocolAdapter } from './protocol.ts';
export {
  type FinishReason,
  type Message,
  type MessageToolCall,
  type ModelAttribution,
  type ModelAttempt,
  type ModelContentPart,
  type ModelEvent,
  type ModelFailureSource,
  type ModelMetrics,
  type ModelRequest,
  type ModelResult,
  type ModelToolCall,
  type ModelTransport,
  type ModelPreflightResult,
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

const RECOVERY_RECHECK_MS = 1_000;
const MAX_TIMER_MS = 2_147_483_647;

/** Wait until a route preflight says the route may be probed, honouring abort. */
async function waitForRouteAdmission(
  preflight: () => ModelPreflightResult | undefined,
  signal: AbortSignal,
  onEvent?: (event: ModelEvent) => void,
): Promise<void> {
  const now = () => Date.now();
  let lastPublishedUntil: number | undefined;
  for (;;) {
    if (signal.aborted) throw abortError();
    const current = preflight();
    if (current?.excluded === true) {
      throw new ModelError('Route is excluded from automatic selection', { kind: 'model_unavailable' });
    }
    if (current?.final !== undefined) {
      throw new ModelError(current.final, {
        kind: 'quota_exhausted',
        source: 'admission',
        retryAt: new Date(current.notBeforeMs).toISOString(),
      });
    }
    const untilMs = current?.notBeforeMs;
    if (untilMs === undefined || untilMs <= now()) return;
    if (lastPublishedUntil !== untilMs) {
      const reason = current?.faultState === 'quota_exhausted' ? 'quota_exhausted' : 'admission';
      onEvent?.({
        type: 'wait',
        attempt: 1,
        kind: 'server',
        delayMs: Math.max(0, untilMs - now()),
        reason,
        retryAt: new Date(untilMs).toISOString(),
      });
      lastPublishedUntil = untilMs;
    }
    const remaining = untilMs - now();
    if (remaining <= 0) return;
    await sleep(Math.min(remaining, RECOVERY_RECHECK_MS), signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, Math.min(ms, MAX_TIMER_MS));
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
      // The application's route identity is the provider-scoped key
      // `provider/registeredModelId`; the Gateway wire carries the bare
      // registered id plus the provider in its own header.
      const identity = routeIdentity(connection, request.model);
      const model = identity === undefined ? undefined : findModel(connection, identity.provider, identity.model);
      if (!model) throw new ModelError(`Unknown gateway model: ${request.model}`, { kind: 'model_unavailable' });
      const protocol = selectSessionProtocol(model.protocols);
      if (protocol === undefined) throw new ModelError(`Model ${request.model} has no supported session protocol`, { kind: 'model_unavailable' });
      const adapter = ADAPTERS[protocol];

      // The serialized body names only the registered model id; the provider is
      // selected separately so one provider's wire spelling never becomes a
      // public model identity.
      const body = adapter.serialize({ ...request, model: model.id });
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
        [GATEWAY_HEADERS.reasoningEffort]: request.reasoningEffort,
        [GATEWAY_HEADERS.provider]: model.provider,
      };
      if (request.attribution?.role !== undefined) headers[GATEWAY_HEADERS.callRole] = request.attribution.role;
      if (request.attribution?.sessionId !== undefined) headers[GATEWAY_HEADERS.sessionId] = request.attribution.sessionId;
      if (request.firstResponseTimeoutSec !== undefined && Number.isFinite(request.firstResponseTimeoutSec)) {
        headers[GATEWAY_HEADERS.firstResponseTimeout] = String(Math.round(request.firstResponseTimeoutSec));
      }
      // Internal, gateway-only attempt correlation: a client-observed fetch
      // failure is reported against this exact attempt id so the same attempt is
      // never double-counted with a Gateway-side fault.
      if (request.attemptId !== undefined) headers['x-wrenyard-gateway-attempt'] = request.attemptId;

      const endpoints: GatewayEndpoints = {
        chat: connection.openaiChatBaseUrl,
        responses: connection.openaiResponsesBaseUrl,
        messages: connection.anthropicBaseUrl,
      };
      const url = adapter.url(endpoints);

      let outputStarted = false;
      /** First time any content of this call was produced; shared with the metrics. */
      let firstOutputMs: number | undefined;
      /** Latest usage the stream actually reported, kept for a failed call. */
      let lastUsage: Usage | undefined;
      const markFirstOutput = (): void => { firstOutputMs ??= Date.now(); };
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
            response = await fetchImpl(url, { method: 'POST', headers, body, signal: request.signal });
          } catch (error) {
            throw networkError(error, request.signal);
          }
          if (!response.ok) throw await httpError(response);
          // The transport always requests a stream, so a successful response that
          // is not an SSE stream is a protocol failure, never a JSON completion.
          const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
          if (!contentType.includes('text/event-stream')) {
            throw new ModelError('Model gateway returned a non-streaming response where a text/event-stream stream was required', { kind: 'protocol' });
          }
          let completion: Completion;
          try {
            completion = await adapter.read(response, request, emit);
          } catch (error) {
            throw normalizeStreamError(error, request.signal, outputStarted);
          }
          attempts.push({ status: 200, ms: Date.now() - attemptStartMs, model: request.model });
          // Only a successfully completed stream yields a sample; the sampler
          // produces nothing for a failed, cancelled or truncated attempt.
          const sample = tps.sample();
          return sample === undefined ? { completion } : { completion, sample: { outputTokens: sample.outputTokens, windowMs: sample.windowMs } };
        } catch (error) {
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
        if (request.preflight !== undefined) {
          await waitForRouteAdmission(request.preflight, request.signal, request.onEvent);
        }
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
            // The local admission distinction and its not-before instant travel
            // with the final failure so the caller reports `retryAt` and never
            // counts a refusal as an upstream retry.
            ...(error.source === undefined ? {} : { source: error.source }),
            ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
            ...(error.upstream === undefined ? {} : { upstream: error.upstream }),
            ...(error.shouldRetry === undefined ? {} : { shouldRetry: error.shouldRetry }),
            ...(error.outputStarted ? { outputStarted: true } : {}),
            metrics,
            cause: error,
          });
        }
        throw error;
      }
    },
  };
}

/**
 * Split the application's provider-scoped route key into its two independent
 * dimensions. A registered model id never contains `/`, so the first separator
 * is unambiguous; a bare id is accepted only when exactly one Gateway model
 * offers it.
 */
function routeIdentity(
  connection: WrenyardGatewayConnection,
  route: string,
): { provider: string; model: string } | undefined {
  const separator = route.indexOf('/');
  if (separator > 0 && separator < route.length - 1) {
    return { provider: route.slice(0, separator), model: route.slice(separator + 1) };
  }
  if (separator !== -1 || route === '') return undefined;
  const matches = connection.models.filter((entry) => entry.id === route);
  return matches.length === 1 ? { provider: matches[0]!.provider, model: route } : undefined;
}

/** Resolve the Gateway model row for one provider plus registered model id. */
function findModel(
  connection: WrenyardGatewayConnection,
  provider: string,
  model: string,
): WrenyardGatewayConnection['models'][number] | undefined {
  return connection.models.find((entry) => entry.provider === provider && entry.id === model);
}
