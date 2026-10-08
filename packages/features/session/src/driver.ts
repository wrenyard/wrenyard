/**
 * session model driver: the in-process inference port.
 *
 * A driver executes exactly one stateless streaming completion and returns the
 * visible text, the reasoning text, the native tool calls and the provider
 * usage. It owns no session state: orchestration, timeouts, budget checks and
 * the ledger live in `calls.ts`. `ModelDriver` is the port every adapter
 * implements; `createGatewayDriver` is the OpenAI-compatible chat adapter and
 * `responses-driver.ts` is the OpenAI Responses adapter. Both share
 * {@link toolCallFromArguments} so an invalid `wy_action` payload is classified
 * identically.
 */
import type { WrenyardGatewayConnection } from '@wrenyard/control-client';

/**
 * One OpenAI-compatible content part. `text` carries visible text; `image_url`
 * carries an image data URL. Only the main reasoning role is ever allowed to
 * send `image_url` parts; every other role is sanitized by `calls.ts`.
 */
export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** One action the model started in an earlier output, replayed as a native tool call. */
export interface ModelToolCall {
  /** The action id; it pairs the call with its `tool` message. */
  id: string;
  type: string;
  intent: string;
}

/**
 * One message of a request, in protocol-neutral form. An `assistant` message is
 * an earlier model output: its text plus the actions it started. A `tool`
 * message is the result of one of those actions and follows its assistant
 * message directly. Each protocol adapter maps these onto its own wire shape.
 */
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ModelContentPart[];
  /** `assistant` only. */
  toolCalls?: ModelToolCall[];
  /** `tool` only. */
  toolCallId?: string;
}

/** The JSON arguments string of a replayed {@link ModelToolCall}. */
export function toolCallArguments(call: ModelToolCall): string {
  return JSON.stringify({ type: call.type, intent: call.intent });
}

/**
 * Provider-reported usage. Only fields the upstream actually reported are set;
 * a missing value stays absent instead of being replaced by `0`, so every field
 * is optional.
 */
export interface Usage {
  input?: number;
  cachedInput?: number;
  output?: number;
  reasoning?: number;
}

export interface DriverRequest {
  /** Gateway public id, always exactly `provider/model`. */
  model: string;
  messages: readonly ModelMessage[];
  /** Public thinking level; forwarded as the wire reasoning-effort parameter. */
  reasoningEffort?: string;
  /** Optional output-token cap; forwarded as the wire `max_tokens` when set. */
  maxTokens?: number;
  /**
   * Stable key grouping requests that share a prompt prefix (the session id),
   * forwarded as the provider's prompt-cache key where the protocol has one.
   */
  cacheKey?: string;
  /** Declare {@link ACTION_TOOL}; parsed calls are reported through {@link DriverRequest.onToolCall}. */
  actionTool?: boolean;
  /** Declare {@link REPLY_TOOL}; the `text` of each call is returned in {@link DriverResult.replies}. */
  replyTool?: boolean;
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** Invoked for every upstream stream event, including ones that carry no visible delta. */
  onActivity?: () => void;
  /** Invoked once per completed tool call, in index order, as soon as it is complete. */
  onToolCall?: (call: ToolCall) => void;
  /** Latest upstream-reported usage, so a caller keeps it on a partial failure. */
  onUsage?: (usage: Usage) => void;
}

/** One parsed native tool call the main reasoning model returned. */
export interface ToolCall {
  index: number;
  type: string;
  intent: string;
  error?: string;
}

/**
 * The one native tool the main reasoning call declares. The model expresses
 * every action as a call to this tool instead of writing `<wy-action>` text;
 * the parsed calls are reported through {@link DriverRequest.onToolCall}.
 */
export const ACTION_TOOL = {
  type: 'function',
  function: {
    name: 'wy_action',
    description:
      'Use read to read material, dispatch to dispatch a task, write to write or revise a document, and ask to ask the user one question that needs their decision. You can call it several times at once. Each call expresses one thing, with intent in natural language.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['read', 'dispatch', 'write', 'ask'],
          description: 'read = read material, dispatch = dispatch a task, write = write or revise a document, ask = ask the user one question that needs their decision.',
        },
        intent: { type: 'string', description: 'The intent of this action, in natural language.' },
      },
      required: ['type', 'intent'],
    },
  },
} as const;

/** The one native tool the communication call declares; not calling it sends nothing. */
export const REPLY_TOOL = {
  type: 'function',
  function: {
    name: 'reply',
    description: 'Send one message to the user. The user sees only this text.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to the user, as Markdown text.' },
      },
      required: ['text'],
    },
  },
} as const;

/** One completed inference result. */
export interface DriverResult {
  /** Message content only; native tool calls are never folded back into text. */
  text: string;
  reasoning?: string;
  usage?: Usage;
  /** Native tool calls the model returned, in call order. */
  toolCalls?: ToolCall[];
  /** The `text` of each {@link REPLY_TOOL} call, in call order. */
  replies?: string[];
}

/** The in-process inference port every adapter implements. */
export interface ModelDriver {
  complete(request: DriverRequest): Promise<DriverResult>;
}

export interface GatewayDriverOptions {
  fetch?: typeof fetch;
}

/**
 * Wire name of the reasoning-effort request field.
 *
 * The Gateway forwards the OpenAI-chat body to the upstream provider verbatim
 * (it only rewrites `model` and `stream_options.include_usage`), and the DSH
 * model patch declares the Gateway route with `api: openai-completions` and no
 * provider-specific thinking mapping, so the OpenAI-style `reasoning_effort`
 * field is the parameter the existing stack actually sends.
 */
const REASONING_EFFORT_FIELD = 'reasoning_effort';

/** Only a non-2xx response body is ever truncated, so an upstream error stays readable. */
const ERROR_EXCERPT_CHARS = 2_000;

/** Hard byte cap for one serialized local-gateway request body (64 MiB). */
export const GATEWAY_REQUEST_MAX_BYTES = 64 * 1024 * 1024;

/** The subset of a driver request that is serialized onto the wire. */
export type GatewayRequestFields = Pick<DriverRequest, 'model' | 'messages' | 'reasoningEffort' | 'maxTokens' | 'actionTool' | 'replyTool'>;

/**
 * Serialize the exact OpenAI-chat body `complete` sends. A caller can use this
 * to preflight the local-gateway byte cap before issuing the request, without
 * guessing any provider-specific limit.
 */
export function serializeGatewayRequest(request: GatewayRequestFields): string {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: mergeConsecutiveMessages(request.messages).map(chatMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.reasoningEffort) body[REASONING_EFFORT_FIELD] = request.reasoningEffort;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.actionTool) body.tools = [ACTION_TOOL];
  else if (request.replyTool) body.tools = [REPLY_TOOL];
  return JSON.stringify(body);
}

/** One message in the chat wire shape. */
function chatMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === 'assistant') {
    const calls = message.toolCalls ?? [];
    return {
      role: 'assistant',
      content: message.content === '' ? null : message.content,
      ...(calls.length === 0 ? {} : {
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: ACTION_TOOL.function.name, arguments: toolCallArguments(call) },
        })),
      }),
    };
  }
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  return { role: message.role, content: message.content };
}

/**
 * Join neighbouring user messages into a single message. The session hands the
 * context over as append-only segments; the chat protocol caches by plain text
 * prefix, so adjacent user segments travel as the parts of one user message.
 */
export function mergeConsecutiveMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  const merged: ModelMessage[] = [];
  for (const message of messages) {
    const last = merged.at(-1);
    if (last === undefined || message.role !== 'user' || last.role !== 'user') {
      merged.push({ ...message });
      continue;
    }
    if (typeof last.content === 'string' && typeof message.content === 'string') {
      last.content = `${last.content}${message.content}`;
      continue;
    }
    last.content = [...contentParts(last.content), ...contentParts(message.content)];
  }
  return merged;
}

function contentParts(content: string | ModelContentPart[]): ModelContentPart[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

/** Gateway-backed streaming driver. */
export function createGatewayDriver(
  connection: WrenyardGatewayConnection,
  options: GatewayDriverOptions = {},
): ModelDriver {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return {
    async complete(request: DriverRequest): Promise<DriverResult> {
      if (request.signal.aborted) throw abortError();
      const url = `${connection.openaiChatBaseUrl.replace(/\/+$/u, '')}/chat/completions`;
      // The exact serialized body is also what the preflight measures, so the
      // cap can never disagree with what is actually sent.
      const body = serializeGatewayRequest(request);
      const actualBytes = Buffer.byteLength(body, 'utf8');
      if (actualBytes > GATEWAY_REQUEST_MAX_BYTES) {
        throw new Error(`Local gateway request exceeds ${GATEWAY_REQUEST_MAX_BYTES} bytes: ${actualBytes}`);
      }

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${connection.token}`,
          },
          body,
          signal: request.signal,
        });
      } catch (error) {
        throw normalizeError(error, request.signal);
      }
      if (!response.ok) {
        const excerpt = await errorExcerpt(response);
        throw new Error(`Model request failed (HTTP ${response.status})${excerpt}`);
      }
      try {
        return await readCompletion(response, request);
      } catch (error) {
        throw normalizeError(error, request.signal);
      }
    },
  };
}

/** Truncated, non-secret excerpt of a failed upstream response body. */
async function errorExcerpt(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  const trimmed = text.trim();
  if (!trimmed) return '';
  const excerpt = trimmed.length > ERROR_EXCERPT_CHARS ? trimmed.slice(0, ERROR_EXCERPT_CHARS) : trimmed;
  return `: ${excerpt}`;
}

/**
 * Read one completion. The Gateway streams SSE for `stream: true`, but a
 * gateway that ignores the flag still answers with an ordinary JSON chat
 * completion, so both shapes are accepted.
 */
async function readCompletion(response: Response, request: DriverRequest): Promise<DriverResult> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/event-stream')) {
    return readJsonCompletion(response, request);
  }
  return readStreamCompletion(response, request);
}

/** Non-stream fallback: one complete chat completion payload. */
async function readJsonCompletion(response: Response, request: DriverRequest): Promise<DriverResult> {
  const payload = await response.json().catch(() => undefined);
  const root = record(payload);
  if (!root) throw new Error('Model response was not valid JSON');
  const failure = root.error;
  if (failure !== undefined) throw new Error(describeFailure(failure, 'Model request failed'));
  const choice = firstChoice(root);
  const message = choice ? record(choice.message) : undefined;
  const toolCalls = message && !request.replyTool ? toolCallsOfMessage(message.tool_calls) : [];
  const replies = message && request.replyTool ? repliesOfMessage(message.tool_calls) : [];
  const text = message ? stringField(message.content) ?? '' : '';
  const reasoning = message ? reasoningField(message) : undefined;
  if (text) request.onText?.(text);
  if (reasoning) request.onReasoning?.(reasoning);
  for (const call of toolCalls) request.onToolCall?.(call);
  const { usage } = usageOf(root);
  if (usage) request.onUsage?.(usage);
  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    ...(usage ? { usage } : {}),
    toolCalls,
    ...(replies.length === 0 ? {} : { replies }),
  };
}

/**
 * Streaming native tool calls: raw argument fragments are accumulated per call
 * index until each call is complete, then parsed and reported once.
 */
interface ToolCallState {
  /** Raw argument text per call index. */
  args: string[];
  /** Call indices observed at least once. */
  seen: Set<number>;
  /** Call indices already completed and reported. */
  completed: Set<number>;
  /** Completed calls, in index order. */
  calls: ToolCall[];
  /** Completed {@link REPLY_TOOL} texts, in index order. */
  replies: string[];
}

interface StreamState {
  text: string;
  reasoning: string;
  usage?: Usage;
  /** Saw `[DONE]`, which ends the read loop. */
  done: boolean;
  /** Saw a terminal indication (`[DONE]` or a `finish_reason`). */
  finished: boolean;
  toolCalls: ToolCallState;
}

/**
 * Parse one native tool call's accumulated arguments into a {@link ToolCall}.
 * Shared by every adapter so an invalid `wy_action` payload is classified
 * identically; a malformed payload yields a call carrying an `error`.
 */
export function toolCallFromArguments(index: number, rawArguments: string | undefined): ToolCall {
  let parsed: Record<string, unknown> | undefined;
  let error: string | undefined;
  try {
    parsed = record(JSON.parse(rawArguments ?? ''));
  } catch {
    error = 'invalid arguments JSON';
  }
  const type = stringField(parsed?.type) ?? '';
  const intent = stringField(parsed?.intent) ?? '';
  if (error === undefined && type === '') error = 'missing type';
  if (error === undefined && intent === '') error = 'missing intent';
  return { index, type, intent, ...(error === undefined ? {} : { error }) };
}

/** The message text of one {@link REPLY_TOOL} call; a malformed payload fails the call. */
export function replyTextFromArguments(rawArguments: string | undefined): string {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = record(JSON.parse(rawArguments ?? ''));
  } catch {
    parsed = undefined;
  }
  const text = parsed?.text;
  if (typeof text !== 'string') throw new Error('Model returned an invalid reply call');
  return text;
}

/** Complete and report every observed call below `limit` that is still pending. */
function completeToolCallsBelow(state: ToolCallState, limit: number, request: DriverRequest): void {
  const pending = [...state.seen].filter((index) => index < limit && !state.completed.has(index)).sort((a, b) => a - b);
  for (const index of pending) completeToolCall(state, index, request);
}

/** Complete and report every still-pending call, in index order. */
function completeToolCalls(state: ToolCallState, request: DriverRequest): void {
  const pending = [...state.seen].filter((index) => !state.completed.has(index)).sort((a, b) => a - b);
  for (const index of pending) completeToolCall(state, index, request);
}

function completeToolCall(state: ToolCallState, index: number, request: DriverRequest): void {
  state.completed.add(index);
  if (request.replyTool) {
    state.replies.push(replyTextFromArguments(state.args[index]));
    return;
  }
  const call = toolCallFromArguments(index, state.args[index]);
  state.calls.push(call);
  request.onToolCall?.(call);
}

/** Accumulate streamed native tool-call argument fragments by index. */
function accumulateToolCalls(raw: unknown, state: ToolCallState, request: DriverRequest): void {
  if (!Array.isArray(raw)) return;
  for (const entry of raw) {
    const call = record(entry);
    if (!call) continue;
    const index = numberField(call.index) ?? state.args.length;
    const piece = stringField(record(call.function)?.arguments) ?? '';
    state.args[index] = `${state.args[index] ?? ''}${piece}`;
    state.seen.add(index);
    // A delta for a higher index means every lower call is now complete.
    completeToolCallsBelow(state, index, request);
  }
}

/** Build the complete calls of a non-streamed message, in call order. */
function toolCallsOfMessage(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  raw.forEach((entry, position) => {
    const call = record(entry);
    const index = numberField(call?.index) ?? position;
    calls.push(toolCallFromArguments(index, stringField(record(call?.function)?.arguments)));
  });
  return calls;
}

/** The {@link REPLY_TOOL} texts of a non-streamed message, in call order. */
function repliesOfMessage(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => replyTextFromArguments(stringField(record(record(entry)?.function)?.arguments)));
}

/**
 * Collect an OpenAI chat SSE body. `delta.content` is visible text, the
 * reasoning variants feed the reasoning channel, and the usage frame carries
 * the official billing numbers. Split frames and split multi-byte characters
 * are carried across chunks. The stream is complete when `[DONE]` or a
 * `finish_reason` arrives; EOF before either is a failure, an abort throws
 * immediately, and the reader and abort listener are always released.
 */
async function readStreamCompletion(response: Response, request: DriverRequest): Promise<DriverResult> {
  const body = response.body;
  if (!body) throw new Error('Model response is missing a body');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const state: StreamState = {
    text: '',
    reasoning: '',
    done: false,
    finished: false,
    toolCalls: { args: [], seen: new Set(), completed: new Set(), calls: [], replies: [] },
  };
  let buffer = '';
  const onAbort = (): void => { void reader.cancel().catch(() => undefined); };
  if (request.signal.aborted) {
    await reader.cancel().catch(() => undefined);
    throw abortError();
  }
  request.signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (!state.done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      // Preserve a trailing CR until the next chunk decides whether it is CRLF.
      buffer = buffer.replace(/\r\n|\r(?!$)/gu, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        consumeStreamFrame(frame, request, state);
        if (state.done) break;
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (!state.done) {
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n?/gu, '\n');
      if (buffer.trim()) consumeStreamFrame(buffer, request, state);
    }
  } finally {
    request.signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
  }
  if (request.signal.aborted) throw abortError();
  if (!state.done && !state.finished) throw new Error('Model stream ended before the reply was complete');
  // The stream is over, so the last call (if any) is complete.
  completeToolCalls(state.toolCalls, request);
  return {
    text: state.text,
    ...(state.reasoning ? { reasoning: state.reasoning } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
    toolCalls: state.toolCalls.calls,
    ...(state.toolCalls.replies.length === 0 ? {} : { replies: state.toolCalls.replies }),
  };
}

/**
 * Consume one complete SSE frame. A frame may carry an error object, a usage
 * object, or a choice delta; only the first choice is ever read.
 */
function consumeStreamFrame(frame: string, request: DriverRequest, state: StreamState): void {
  const dataLines = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart());
  if (dataLines.length === 0) return;
  const payload = dataLines.join('\n').trim();
  if (payload === '[DONE]') {
    state.done = true;
    state.finished = true;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error('Model stream returned invalid data');
  }
  const root = record(parsed);
  if (!root) return;
  request.onActivity?.();
  if (root.error !== undefined) throw new Error(describeFailure(root.error, 'Model request failed'));

  const { usage } = usageOf(root);
  if (usage) {
    state.usage = { ...state.usage, ...usage };
    request.onUsage?.(state.usage);
  }

  const choice = firstChoice(root);
  if (!choice) return;
  if (stringField(choice.finish_reason) !== undefined) state.finished = true;
  const delta = record(choice.delta) ?? record(choice.message);
  if (!delta) return;

  const content = stringField(delta.content);
  if (content) {
    state.text += content;
    request.onText?.(content);
  }
  accumulateToolCalls(delta.tool_calls, state.toolCalls, request);
  const reasoning = reasoningField(delta);
  if (reasoning) {
    state.reasoning += reasoning;
    request.onReasoning?.(reasoning);
  }
}

/**
 * First non-empty reasoning field of a delta. OpenCode-compatible endpoints may
 * return several spellings for the same content, so only the first is used.
 */
function reasoningField(source: Record<string, unknown>): string | undefined {
  return stringField(source.reasoning_content) ?? stringField(source.reasoning) ?? stringField(source.reasoning_text);
}

/** Usage of one payload, present only when upstream actually reported it. */
function usageOf(root: Record<string, unknown>): { usage?: Usage } {
  const raw = record(root.usage);
  if (!raw) return {};
  const input = numberField(raw.prompt_tokens);
  const output = numberField(raw.completion_tokens);
  const promptDetails = record(raw.prompt_tokens_details);
  const completionDetails = record(raw.completion_tokens_details);
  const cachedInput = promptDetails ? numberField(promptDetails.cached_tokens) : undefined;
  const reasoning = completionDetails ? numberField(completionDetails.reasoning_tokens) : undefined;
  const usage: Usage = {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
  return Object.keys(usage).length === 0 ? {} : { usage };
}

function firstChoice(root: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = root.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  return record(choices[0]);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Human-readable message of a streamed gateway error frame or error object. */
function describeFailure(failure: unknown, fallback: string): string {
  if (typeof failure === 'string' && failure) return failure;
  const message = record(failure)?.message;
  if (typeof message === 'string' && message) return message;
  return fallback;
}

/** Preserve an abort as an abort; rewrite anything else into a plain Error. */
function normalizeError(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return abortError();
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Phrases upstream providers use when a request exceeds their context window.
 * The gateway forwards the provider body verbatim, so a small set of stable
 * phrases is matched instead of a provider-specific error code.
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context[_ ]length/iu,
  /context window/iu,
  /maximum context/iu,
  /context overflow/iu,
  /exceeds? the (?:maximum )?context/iu,
  /(?:prompt|input|request|messages?)[^.\n]*too (?:long|large)/iu,
  /too many tokens/iu,
  /reduce the length of the messages?/iu,
];

/**
 * True when a failure is an upstream context-window overflow. `calls.ts` uses
 * this to prefix the `call` event error with `context_overflow:` so Desktop can
 * classify the failed turn without parsing provider wording.
 */
export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (message === '') return false;
  if (message.startsWith('context_overflow:')) return true;
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

function abortError(): Error {
  const error = new Error('Model request was aborted');
  error.name = 'AbortError';
  return error;
}
