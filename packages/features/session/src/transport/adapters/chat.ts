/**
 * OpenAI Chat Completions protocol adapter.
 *
 * Serializes one {@link ModelRequest} as a streaming chat completion and reads
 * either an SSE stream or, when the Gateway ignores `stream`, one JSON
 * completion. It owns no retry and performs no fetch.
 */
import {
  numberField,
  parseToolArguments,
  record,
  stringField,
  type AdapterEmit,
  type Completion,
  type FinishReason,
  type GatewayEndpoints,
  type Message,
  type ModelContentPart,
  type ModelRequest,
  type ModelToolCall,
  type ProtocolAdapter,
  type ToolChoice,
  type ToolSpec,
  type Usage,
} from '../protocol.ts';
import { abortError, classifyOfficialError, describeFailure, incompleteStreamError, streamError, upstreamErrorIdentity } from '../errors.ts';
import { readSseStream } from '../shared-sse-reader.ts';

/** Hard byte cap for one serialized chat request body (64 MiB). */
export const CHAT_REQUEST_MAX_BYTES = 64 * 1024 * 1024;

export const chatAdapter: ProtocolAdapter = {
  protocol: 'openai_chat',
  label: 'Local gateway request',
  maxBytes: CHAT_REQUEST_MAX_BYTES,
  url: (endpoints: GatewayEndpoints): string => `${endpoints.chat.replace(/\/+$/u, '')}/chat/completions`,
  serialize: serializeChatRequest,
  read: readChat,
};

/**
 * Serialize the exact chat body. The resolved reasoning effort is deliberately
 * absent: it travels in the Gateway reasoning-effort header, never as a raw
 * body field.
 */
export function serializeChatRequest(request: ModelRequest): string {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: mergeConsecutiveMessages(request.messages).map(chatMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
  // An explicit Fast preference maps onto the official service tier. An absent
  // preference leaves the body untouched so the upstream default applies.
  if (request.fast !== undefined) body.service_tier = request.fast ? 'priority' : 'default';
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map(chatTool);
    // Serialize the caller's tool choice in the Chat wire shape; an unspecified
    // choice defaults to `auto`.
    body.tool_choice = chatToolChoice(request.toolChoice);
  }
  // CodeBuddy upstream API limitation (verified 2026-10-09): /v2/chat/completions
  // does not enforce string tool_choice: required can return ordinary content,
  // none can return tool calls, and named-tool objects are rejected. The choice
  // is still serialized per the protocol; do not rely on it to enforce replies.
  // Keep the prompt's reply/silence contract explicit, with an additional
  // mandatory tool-call instruction at turn end.
  return JSON.stringify(body);
}

/** Serialize one toolbox choice in the Chat Completions `tool_choice` shape. */
function chatToolChoice(choice: ToolChoice | undefined): unknown {
  if (choice === undefined || choice === 'auto') return 'auto';
  if (choice === 'none') return 'none';
  if (choice === 'required') return 'required';
  return { type: 'function', function: { name: choice.name } };
}

/** One declared tool in the chat wire shape (nested `function` object). */
function chatTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

/** One message in the chat wire shape. */
function chatMessage(message: Message): Record<string, unknown> {
  if (message.role === 'assistant') {
    const calls = message.toolCalls ?? [];
    return {
      role: 'assistant',
      content: message.content === '' ? null : message.content,
      ...(calls.length === 0 ? {} : {
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
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
export function mergeConsecutiveMessages(messages: readonly Message[]): Message[] {
  const merged: Message[] = [];
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

/** Per-index accumulation of raw id, name and argument fragments. */
interface ToolCallState {
  parts: { id: string; name: string; arguments: string }[];
  seen: Set<number>;
  completed: Set<number>;
  calls: ModelToolCall[];
}

interface StreamState {
  text: string;
  reasoning: string;
  usage?: Usage;
  done: boolean;
  finishReason?: FinishReason;
  toolCalls: ToolCallState;
  /** Response headers, so an in-stream error keeps the upstream retry hints. */
  headers: Headers;
}

/** Collect a chat SSE body into a {@link Completion}. Only `[DONE]` is terminal. */
async function readChat(response: Response, request: ModelRequest, emit: AdapterEmit): Promise<Completion> {
  const state: StreamState = {
    text: '',
    reasoning: '',
    done: false,
    toolCalls: { parts: [], seen: new Set(), completed: new Set(), calls: [] },
    headers: response.headers,
  };
  await readSseStream(response, request.signal, (frame) => consumeFrame(frame, state, emit), () => state.done);
  if (request.signal.aborted) throw abortError();
  // The Chat protocol is successful only on `[DONE]`; a `finish_reason` alone
  // is a truncated stream, never a silent success.
  if (!state.done) throw incompleteStreamError();
  completeToolCalls(state.toolCalls, emit);
  return {
    text: state.text,
    ...(state.reasoning ? { reasoning: state.reasoning } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
    toolCalls: state.toolCalls.calls,
    ...(state.finishReason === undefined ? {} : { finishReason: state.finishReason }),
  };
}

/** Consume one complete chat SSE frame. */
function consumeFrame(frame: string, state: StreamState, emit: AdapterEmit): void {
  const dataLines = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart());
  if (dataLines.length === 0) return;
  const payload = dataLines.join('\n').trim();
  if (payload === '[DONE]') {
    state.done = true;
    // Only `[DONE]` is the Chat protocol's successful completion.
    emit.complete();
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
  emit.activity();
  // Only a non-null official error object is an error; a null `error` is not.
  const failure = record(root.error);
  if (failure) {
    const identity = upstreamErrorIdentity(root);
    emit.fail();
    throw streamError({ kind: classifyOfficialError(identity.type, identity.code), message: describeFailure(failure, 'Model request failed'), upstream: identity, headers: state.headers });
  }

  const usage = usageOf(root);
  if (usage) {
    state.usage = { ...state.usage, ...usage };
    emit.usage(state.usage);
  }

  const choice = firstChoice(root);
  if (!choice) return;
  const finish = stringField(choice.finish_reason);
  if (finish !== undefined) {
    state.finishReason = finishReasonOf(finish, state.toolCalls.seen.size);
    // A content_filtered or errored completion is not a clean generation: no
    // speed sample.
    if (state.finishReason === 'content_filter' || finish === 'error') emit.fail();
  }
  // Only a real `delta` frame is streamed generation; a `message` snapshot is
  // never counted by the sampler.
  const streamedDelta = record(choice.delta);
  const delta = streamedDelta ?? record(choice.message);
  if (!delta) return;
  const choiceIndex = numberField(choice.index) ?? 0;
  const streamed = streamedDelta !== undefined;

  const content = stringField(delta.content);
  if (content) {
    state.text += content;
    emit.text(content);
    if (streamed) emit.generation(`content:${choiceIndex}`, content);
  }
  accumulateToolCalls(delta.tool_calls, state, choiceIndex, streamed, emit);
  const reasoning = reasoningField(delta);
  if (reasoning) {
    state.reasoning += reasoning;
    emit.reasoning(reasoning);
    if (streamed) emit.generation(`reasoning:${choiceIndex}`, reasoning);
  }
}

/** Complete and report every observed call below `limit` that is still pending. */
function completeToolCallsBelow(state: ToolCallState, limit: number, emit: AdapterEmit): void {
  const pending = [...state.seen].filter((index) => index < limit && !state.completed.has(index)).sort((a, b) => a - b);
  for (const index of pending) completeToolCall(state, index, emit);
}

/** Complete and report every still-pending call, in index order. */
function completeToolCalls(state: ToolCallState, emit: AdapterEmit): void {
  const pending = [...state.seen].filter((index) => !state.completed.has(index)).sort((a, b) => a - b);
  for (const index of pending) completeToolCall(state, index, emit);
}

function completeToolCall(state: ToolCallState, index: number, emit: AdapterEmit): void {
  state.completed.add(index);
  const part = state.parts[index] ?? { id: '', name: '', arguments: '' };
  emit.toolCall(parseCall(index, part.id !== '' ? part.id : `call_${index}`, part.name, part.arguments, state));
}

/** Accumulate streamed native tool-call id, name and argument fragments by index. */
function accumulateToolCalls(raw: unknown, state: StreamState, choiceIndex: number, streamed: boolean, emit: AdapterEmit): void {
  if (!Array.isArray(raw)) return;
  for (const entry of raw) {
    const call = record(entry);
    if (!call) continue;
    const fn = record(call.function);
    const piece = stringField(fn?.arguments) ?? '';
    const id = stringField(call.id);
    const name = stringField(fn?.name);
    // Any tool-call fragment — an id-only fragment included — starts output.
    if (id !== undefined || name !== undefined || piece !== '') emit.output();
    const index = numberField(call.index) ?? state.toolCalls.parts.length;
    const part = state.toolCalls.parts[index] ?? { id: '', name: '', arguments: '' };
    if (id !== undefined) part.id = id;
    if (name !== undefined) part.name = name;
    part.arguments += piece;
    state.toolCalls.parts[index] = part;
    state.toolCalls.seen.add(index);
    // Only raw argument fragments are generation; a completed call is never
    // counted a second time.
    if (piece !== '' && streamed) emit.generation(`tool:${choiceIndex}:${index}`, piece);
    completeToolCallsBelow(state.toolCalls, index, emit);
  }
}

/** Build one completed call, deriving `parsed`/`parseError` from the raw arguments. */
function parseCall(index: number, id: string, name: string, argumentsText: string, state?: ToolCallState): ModelToolCall {
  const call: ModelToolCall = { index, id, name, arguments: argumentsText, ...parseToolArguments(argumentsText) };
  state?.calls.push(call);
  return call;
}

/** First non-empty reasoning field of a delta. */
function reasoningField(source: Record<string, unknown>): string | undefined {
  return stringField(source.reasoning_content) ?? stringField(source.reasoning) ?? stringField(source.reasoning_text);
}

/** Usage of one payload, present only when upstream actually reported it. */
function usageOf(root: Record<string, unknown>): Usage | undefined {
  const raw = record(root.usage);
  if (!raw) return undefined;
  const input = numberField(raw.prompt_tokens);
  const output = numberField(raw.completion_tokens);
  const promptDetails = record(raw.prompt_tokens_details);
  const completionDetails = record(raw.completion_tokens_details);
  const cachedInput = promptDetails ? numberField(promptDetails.cached_tokens) : undefined;
  const reasoning = completionDetails ? numberField(completionDetails.reasoning_tokens) : undefined;
  const usage: Usage = {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(cachedInput === undefined ? {} : { cachedInputTokens: cachedInput }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function firstChoice(root: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = root.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  return record(choices[0]);
}

/** Map the chat `finish_reason` onto the normalized reason. */
function finishReasonOf(raw: string | undefined, toolCallCount: number): FinishReason | undefined {
  if (raw === undefined) return toolCallCount > 0 ? 'tool_calls' : undefined;
  switch (raw) {
    case 'stop': return 'stop';
    case 'length': return 'length';
    case 'tool_calls':
    case 'function_call': return 'tool_calls';
    case 'content_filter': return 'content_filter';
    default: return toolCallCount > 0 ? 'tool_calls' : 'stop';
  }
}
