/**
 * Unified session model-call protocol.
 *
 * The transport hides the three Gateway protocols (Chat Completions,
 * Responses, Messages) behind one request/result contract. Application code
 * builds a {@link ModelRequest} and consumes {@link ModelEvent}s and a
 * {@link ModelResult}; it never sees a wire shape, an endpoint or a retry
 * decision. The retry policy is fixed inside the transport, so a request never
 * carries retry parameters.
 */
import type { ReasoningEffort } from '@wrenyard/models';
import type { ModelErrorKind } from './errors.ts';

/** One OpenAI-compatible content part. `text` is visible text; `image_url` a data URL. */
export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** One tool a caller declares on a request, in protocol-neutral form. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One native tool call the model returned, in protocol-neutral form. */
export interface ToolCall {
  index: number;
  /** Upstream call id, or `call_<index>` when upstream did not provide one. */
  id: string;
  name: string;
  /** Raw JSON arguments text, exactly as upstream produced it. */
  arguments: string;
}

/**
 * A completed tool call plus its parsed arguments. `parsed` is the
 * `JSON.parse` result and `parseError` its message; exactly one is present
 * when the arguments were captured.
 */
export interface ModelToolCall extends ToolCall {
  parsed?: unknown;
  parseError?: string;
}

/** One tool call an earlier assistant output started, replayed on a request. */
export interface MessageToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments text, exactly as the model produced it. */
  arguments: string;
}

/**
 * One message of a request, in protocol-neutral form. An `assistant` message is
 * an earlier model output: its text plus the tool calls it started. A `tool`
 * message is the result of one of those calls and follows its assistant
 * message directly. Each protocol adapter maps these onto its own wire shape.
 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ModelContentPart[];
  /** `assistant` only. */
  toolCalls?: MessageToolCall[];
  /** `tool` only. */
  toolCallId?: string;
}

/**
 * Provider-reported usage. Only fields the upstream actually reported are set;
 * a missing value stays absent instead of being replaced by `0`.
 */
export interface Usage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

/** How the caller wants tools used; defaults to `auto`. */
export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

/** Normalized completion reason. */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

/* ── Protocol selection ───────────────────────────────────────────────────── */

/**
 * The Gateway's three protocol entry points, in the session's fixed precedence
 * order Chat → Responses → Messages. This module is browser-safe: it depends on
 * no Node built-in, so a consumer (for example Desktop's model list) can pick a
 * model's protocol without pulling in the transport's fetch implementation.
 */
export const SESSION_PROTOCOLS = ['openai_chat', 'openai_responses', 'anthropic_messages'] as const;
export type SessionProtocol = (typeof SESSION_PROTOCOLS)[number];

/**
 * The protocol a session call uses for a model, by the fixed precedence
 * Chat → Responses → Messages. It reads only the model's own per-model protocol
 * list; `undefined` means the model has no session-supported protocol.
 */
export function selectSessionProtocol(protocols: readonly string[] | undefined): SessionProtocol | undefined {
  return SESSION_PROTOCOLS.find((protocol) => protocols?.includes(protocol) === true);
}

/** True when a model's per-model protocols admit a session call at all. */
export function supportsSession(model: { protocols?: readonly string[] }): boolean {
  return selectSessionProtocol(model.protocols) !== undefined;
}

/* ── Upstream retry hint ──────────────────────────────────────────────────── */

/** Which upstream response header supplied an adopted retry hint. */
export type RetryAfterSource = 'retry-after' | 'retry-after-ms';

/**
 * An upstream retry hint the transport actually adopted. The original header
 * value is kept verbatim so a caller can record the supplier's own wording in
 * the ledger; `delayMs` is the wait that was applied.
 */
export interface RetryAfterHint {
  source: RetryAfterSource;
  value: string;
  delayMs: number;
}

/** Request attribution metadata; never sent to the supplier. */
export interface ModelAttribution {
  role?: string;
  sessionId?: string;
}

/** One unified model call. The retry policy is fixed inside the transport. */
export interface ModelRequest {
  /** Gateway public id, always exactly `provider/model`. */
  model: string;
  messages: readonly Message[];
  /** Required public reasoning level; forwarded as a Gateway request header. */
  reasoningEffort: ReasoningEffort;
  /** Tools the model may call. */
  tools?: readonly ToolSpec[];
  /** Tool usage preference; adapters map it where the protocol supports it. */
  toolChoice?: ToolChoice;
  /** Optional output-token cap, mapped onto the protocol's own field. */
  maxOutputTokens?: number;
  /** Stable prefix-cache key, mapped where the protocol has one. */
  cacheKey?: string;
  /** Attribution metadata for the Gateway event; never sent upstream. */
  attribution?: ModelAttribution;
  /**
   * When true the transport never runs its same-route retry loop. A caller that
   * owns its own bounded cross-route failover sets it so a failover can never
   * multiply attempts on one route.
   */
  noRetry?: boolean;
  /**
   * Absolute instant (epoch ms) at which this call's own budget expires. It is
   * sent to the Gateway as internal deadline metadata (never upstream) so a
   * client-observed timeout is accounted to the route even though the Gateway
   * sees only a disconnect.
   */
  deadlineAtMs?: number;
  /**
   * Gateway-only correlation id of this attempt, sent as an internal header. It
   * lets the Gateway tie a client-reported timeout or fetch failure to the exact
   * attempt it already knows about, so one attempt is never double-counted.
   */
  attemptId?: string;
  signal: AbortSignal;
  /** Called for every event of the call, in arrival order. */
  onEvent?: (event: ModelEvent) => void;
}

/**
 * One transport event. The first `text`, `reasoning` or `tool_call` event marks
 * the call as having started output; `retry` is emitted before each same-route
 * retry so a caller can treat the wait as activity. `retry.retryAfter` is present
 * only when an upstream hint was actually adopted for that retry; an ordinary
 * exponential-backoff retry never carries it.
 */
export type ModelEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; call: ModelToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'activity' }
  | { type: 'retry'; attempt: number; kind: ModelErrorKind; status?: number; delayMs: number; retryAfter?: RetryAfterHint };

/** One request actually issued during a call, in order. */
export interface ModelAttempt {
  /** HTTP status of this request, when one was received. */
  status?: number;
  /** Failure kind of this request; absent on the successful one. */
  error?: ModelErrorKind;
  /** Duration of this request in milliseconds. */
  ms: number;
  /** Wait before this request, when it is a retry. */
  waitedMs?: number;
  /** Present only when an upstream retry hint was adopted for that wait. */
  retryAfter?: RetryAfterHint;
  /** The route this request was issued for, when a caller distinguishes routes. */
  model?: string;
  /** When this route is expected to recover, from an adopted hint or route state. */
  routeUntil?: string;
}

/** Measured facts of one completed or failed call, produced by the transport. */
export interface ModelMetrics {
  /** Model id the upstream reported, when it differs or is known. */
  responseModel?: string;
  finishReason?: FinishReason;
  usage?: Usage;
  /** Milliseconds from the first request being sent to the first output (text, reasoning or tool-call argument). */
  ttftMs?: number;
  /** Total time visible content was streaming, from the shared sampler. */
  streamMs?: number;
  /** Sampler token count of that streamed content. */
  streamTokens?: number;
  /** Every request actually issued, in order. */
  attempts: ModelAttempt[];
}

/** One unified completion result. */
export interface ModelResult {
  /** Message content only; native tool calls are never folded back into text. */
  text: string;
  reasoning?: string;
  /** Native tool calls the model returned, in call order. */
  toolCalls: ModelToolCall[];
  usage?: Usage;
  finishReason?: FinishReason;
  /** Measured facts of the call, produced by the transport. */
  metrics: ModelMetrics;
}

/** The one inference port over the Gateway that every role calls. */
export interface ModelTransport {
  complete(request: ModelRequest): Promise<ModelResult>;
}

/* ── Adapter contract ─────────────────────────────────────────────────────── */

/** The three Gateway protocol entry points the transport may use. */
export interface GatewayEndpoints {
  chat: string;
  responses: string;
  messages: string;
}

/** Streaming sink an adapter reports through while reading a response. */
export interface AdapterEmit {
  text(delta: string): void;
  reasoning(delta: string): void;
  toolCall(call: ModelToolCall): void;
  usage(usage: Usage): void;
  activity(): void;
  /** A generated fragment not yet a complete event, such as a tool-call delta. */
  output(): void;
  /**
   * One real streamed generation delta on a stable, protocol-chosen channel:
   * output text, thinking, or a tool-argument fragment. A `message` snapshot or
   * a completed value is never reported. The transport feeds these to the
   * shared speed sampler; a protocol adapter itself never samples.
   */
  generation(channel: string, delta: string): void;
  /** The protocol's successful completion marker, for the speed sampler. */
  complete(): void;
  /** An error, cancellation or truncation: the speed sampler produces no sample. */
  fail(): void;
}

/** The protocol-neutral result of one adapter read, before attempt statistics. */
export interface Completion {
  text: string;
  reasoning?: string;
  toolCalls: ModelToolCall[];
  usage?: Usage;
  finishReason?: FinishReason;
}

/**
 * One protocol adapter. It owns the endpoint, request serialization and
 * response/stream parsing of exactly one Gateway protocol. It never performs a
 * fetch and never retries.
 */
export interface ProtocolAdapter {
  /** The Gateway protocol this adapter speaks. */
  readonly protocol: 'openai_chat' | 'openai_responses' | 'anthropic_messages';
  /** Names the request in the byte-cap error. */
  readonly label: string;
  /** Hard byte cap for one serialized request body. */
  readonly maxBytes: number;
  /** POST target for the connection's base URLs. */
  url(endpoints: GatewayEndpoints): string;
  /** Serialize the exact body; called once, before the first attempt. */
  serialize(request: ModelRequest): string;
  /** Read one response, emitting events as it goes. */
  read(response: Response, request: ModelRequest, emit: AdapterEmit): Promise<Completion>;
}

/* ── Wire-parsing helpers shared by the adapters and the action tools ─────── */

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Parse a tool call's raw argument text, capturing a parse failure instead of throwing. */
export function parseToolArguments(argumentsText: string): { parsed?: unknown; parseError?: string } {
  if (argumentsText === '') return { parsed: undefined };
  try {
    return { parsed: JSON.parse(argumentsText) };
  } catch (error) {
    return { parseError: error instanceof Error ? error.message : String(error) };
  }
}
