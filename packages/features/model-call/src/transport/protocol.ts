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
import type { FinishReason, ModelAttempt, ModelErrorKind, ModelMetrics, RetryAfterHint, RetryAfterSource, Usage } from '@wrenyard/protocol/session';

/**
 * The model-call fact types are the wire shape of ledger span metrics, so they
 * are declared in `@wrenyard/protocol/session` and re-exported here under their
 * original names; the transport's functions and runtime values stay local.
 */
export type { FinishReason, ModelAttempt, ModelMetrics, RetryAfterHint, RetryAfterSource, Usage };

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

/** How the caller wants tools used; defaults to `auto`. */
export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

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

/**
 * Where a normalized failure originated. `upstream` is a real supplier
 * response, connection failure or stream fault; `admission` is the local
 * Gateway circuit refusing to admit the request, which never reached upstream,
 * so it must never consume the upstream retry count or extend a cooldown.
 */
export type ModelFailureSource = 'upstream' | 'admission';

/**
 * Why the transport is waiting before its next attempt. `admission` is waiting
 * for permission to probe a locally blocked route; `recovery` is a guaranteed
 * wait until an adopted not-before instant; `quota_exhausted` is waiting on a
 * free-quota block with a known or unknown reset time.
 */
export type ModelWaitReason = 'admission' | 'recovery' | 'quota_exhausted';

/**
 * Local route-health read before an attempt: when the route admits requests
 * again. `final` is set when the call must not be sent or waited for at all (an
 * exhausted quota with a stated reset) and is the reason the turn ends with.
 */
export type ModelPreflightResult = { notBeforeMs: number; faultState?: string; final?: string; excluded?: boolean };

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
  /**
   * Explicit Fast preference: true requests Fast on, false requests Fast off,
   * and `undefined` means no preference at all. Optional on purpose, so an
   * absent preference stays distinguishable from an explicit off.
   */
  fast?: boolean;
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
   * First-response timeout in whole seconds (1–600) for streaming Gateway
   * requests. Omitted values use the Gateway default (120 s).
   */
  firstResponseTimeoutSec?: number;
  /**
   * Gateway-only correlation id of this attempt, sent as an internal header. It
   * lets the Gateway tie a client-reported fetch failure to the exact attempt it
   * already knows about, so one attempt is never double-counted.
   */
  attemptId?: string;
  /**
   * Optional route-health pre-check before the single upstream attempt: a
   * `final` message ends without sending; a future `notBeforeMs` is waited out
   * (honouring abort) before the one send.
   */
  preflight?: () => ModelPreflightResult | undefined;
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
 *
 * `wait` is the recovery wait: the transport is not retrying an upstream
 * failure but waiting until an absolute not-before instant — a local Gateway
 * admission refusal (never counted as an upstream retry) or a guaranteed
 * recovery after an adopted hint. `wait.reason` distinguishes waiting for
 * permission to probe from a granted recovery and `wait.retryAt` is the exact
 * instant the next probe/recovery is due. It is absent when no real instant is
 * known, so an unknown recovery time is reported as unknown rather than as a
 * fallback recheck delay.
 */
export type ModelEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; call: ModelToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'activity' }
  | { type: 'retry'; attempt: number; kind: ModelErrorKind; status?: number; delayMs: number; retryAfter?: RetryAfterHint }
  | { type: 'wait'; attempt: number; kind: ModelErrorKind; status?: number; delayMs: number; reason: ModelWaitReason; retryAt?: string; retryAfter?: RetryAfterHint };

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
