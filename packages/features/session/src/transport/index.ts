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
import { TpsGenerationCollector } from '@wrenyard/agent-client/statistics';
import type { WrenyardGatewayConnection } from '@wrenyard/control';
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
export { MAX_RETRIES, BASE_DELAY_MS, MIN_RECOVERY_DELAY_MS, isRetryable, retryDelayMs, runWithRetry, RouteReselectError, type RetryDecision, type RetryContext, type RouteReselectReason } from './retry.ts';

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
      // Internal, gateway-only deadline metadata: a call advertises the instant
      // its own budget expires so a client-observed timeout is recorded against
      // the route rather than mistaken for a cancellation. Never sent upstream.
      if (request.deadlineAtMs !== undefined && Number.isFinite(request.deadlineAtMs)) headers['x-wrenyard-deadline'] = String(Math.round(request.deadlineAtMs));
      // Internal, gateway-only attempt correlation: a client-observed timeout or
      // fetch failure is reported against this exact attempt id so the same
      // attempt is never double-counted with a Gateway-side timeout.
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
      /** The wait an `onRetry` decided for the next request, consumed by it. */
      let pendingWait: { waitedMs?: number; retryAfter?: RetryAfterHint } = {};
      const startedMs = Date.now();
      const attempt = async (): Promise<{ completion: Completion; sample?: { outputTokens: number; windowMs: number } }> => {
        if (request.signal.aborted) throw abortError();
        const attemptStartMs = Date.now();
        const wait = pendingWait;
        pendingWait = {};
        // The wait (a backoff retry or a recovery wait) is over and a real
        // upstream request is about to start. Reporting it as `activity`
        // re-arms the caller's idle deadline for this attempt and lets it clear
        // its live waiting state right before the attempt, with no timer. The
        // auxiliary noRetry path never sets `pendingWait`, so it is unchanged.
        if (wait.waitedMs !== undefined) request.onEvent?.({ type: 'activity' });
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
          attempts.push({ status: 200, ms: Date.now() - attemptStartMs, model: request.model, ...wait });
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
            ...wait,
            ...(error.retryAfterMs === undefined ? {} : { routeUntil: new Date(Date.now() + error.retryAfterMs).toISOString() }),
          };
          attempts.push(record);
          throw error;
        }
      };

      // An auxiliary call disables the same-route retry loop so a failover
      // cannot multiply attempts on one route; every other call keeps it.
      const noSameRouteRetry = request.noRetry === true;
      try {
        const { completion, sample } = noSameRouteRetry ? await attempt() : await runWithRetry(attempt, {
          signal: request.signal,
          outputStarted: () => outputStarted,
          // A main-reasoning route-health wait is owned by this same loop, so a
          // blocked route is waited out here rather than probed early.
          ...(request.preflight === undefined ? {} : { preflight: request.preflight }),
          ...(request.reselect === true ? { reselect: true } : {}),
          onRetry: (decision) => {
            pendingWait = {
              waitedMs: decision.delayMs,
              ...(decision.retryAfter === undefined ? {} : { retryAfter: decision.retryAfter }),
            };
            // A recovery wait is its own event: it says whether the call is
            // waiting for permission to probe or for a guaranteed recovery, and
            // carries the absolute instant the next attempt is due whenever a
            // real instant is known. A wait with no known instant carries no
            // `retryAt`, so its recovery time stays observably unknown.
            if (decision.wait !== undefined) {
              request.onEvent?.({
                type: 'wait',
                attempt: decision.attempt,
                kind: decision.kind,
                ...(decision.status === undefined ? {} : { status: decision.status }),
                delayMs: decision.delayMs,
                reason: decision.wait.reason,
                ...(decision.wait.retryAt === undefined ? {} : { retryAt: decision.wait.retryAt }),
                ...(decision.retryAfter === undefined ? {} : { retryAfter: decision.retryAfter }),
              });
              return;
            }
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
