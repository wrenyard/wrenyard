/**
 * Anthropic Messages protocol adapter.
 *
 * Implements the {@link ProtocolAdapter} contract on the official Messages API
 * (`POST {anthropicBaseUrl}/messages`). The system messages become the top-level
 * `system` field, the remaining messages become `messages` with Anthropic
 * content blocks, and every declared tool becomes an `input_schema` tool. It
 * owns no retry and performs no fetch.
 */
import { TpsGenerationCollector } from '@wrenyard/agent-client/statistics';
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
import { abortError, classifyOfficialError, describeFailure, incompleteStreamError, networkError, streamError, upstreamErrorIdentity } from '../errors.ts';

/** Hard byte cap for one serialized Messages request body (64 MiB). */
export const MESSAGES_REQUEST_MAX_BYTES = 64 * 1024 * 1024;

/** `max_tokens` is required by the Messages API; used when the caller set none. */
export const DEFAULT_MESSAGES_MAX_TOKENS = 8_192;

export const messagesAdapter: ProtocolAdapter = {
  protocol: 'anthropic_messages',
  label: 'Messages request',
  maxBytes: MESSAGES_REQUEST_MAX_BYTES,
  url: (endpoints: GatewayEndpoints): string => `${endpoints.messages.replace(/\/+$/u, '')}/messages`,
  serialize: serializeMessagesRequest,
  read: readMessages,
};

/** Serialize the exact Messages body. */
export function serializeMessagesRequest(request: ModelRequest): string {
  return JSON.stringify(buildMessagesBody(request));
}

function buildMessagesBody(request: ModelRequest): Record<string, unknown> {
  const systemText: string[] = [];
  const messages: { role: 'user' | 'assistant'; content: Record<string, unknown>[] }[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') {
      systemText.push(textOf(message.content));
      continue;
    }
    const entry = messageEntry(message);
    const previous = messages.at(-1);
    if (previous !== undefined && previous.role === entry.role) previous.content.push(...entry.content);
    else messages.push(entry);
  }
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? DEFAULT_MESSAGES_MAX_TOKENS,
    messages,
    stream: true,
  };
  if (systemText.length > 0) body.system = systemText.join('\n\n');
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map(messagesTool);
    // An unspecified choice defaults to `auto`; the supported internal forms map
    // onto the official Messages `tool_choice` shapes.
    body.tool_choice = messagesToolChoice(request.toolChoice);
  }
  return body;
}

/** One declared tool in the Messages wire shape. */
function messagesTool(tool: ToolSpec): Record<string, unknown> {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

/** Serialize one toolbox choice in the Messages `tool_choice` shape. */
function messagesToolChoice(choice: ToolChoice | undefined): unknown {
  if (choice === undefined || choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  return { type: 'tool', name: choice.name };
}

/** One Anthropic message entry for a user/assistant/tool message. */
function messageEntry(message: Message): { role: 'user' | 'assistant'; content: Record<string, unknown>[] } {
  if (message.role === 'assistant') {
    const content: Record<string, unknown>[] = [];
    const text = textOf(message.content);
    if (text !== '') content.push({ type: 'text', text });
    for (const call of message.toolCalls ?? []) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: parseInput(call.arguments) });
    }
    return { role: 'assistant', content };
  }
  if (message.role === 'tool') {
    return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: textOf(message.content) }] };
  }
  return { role: 'user', content: contentBlocks(message.content) };
}

/** Map one content value onto Anthropic user content blocks. */
function contentBlocks(content: string | ModelContentPart[]): Record<string, unknown>[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((part) => part.type === 'text'
    ? { type: 'text', text: part.text }
    : imageBlock(part.image_url.url));
}

/** One image block from a data URL, falling back to a text descriptor. */
function imageBlock(url: string): Record<string, unknown> {
  const match = /^data:([^;,]+);base64,(.*)$/su.exec(url);
  if (!match) return { type: 'text', text: '[image: unsupported source]' };
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
}

/** The plain text of a message, concatenating every text part. */
function textOf(content: string | ModelContentPart[]): string {
  if (typeof content === 'string') return content;
  let text = '';
  for (const part of content) if (part.type === 'text') text += part.text;
  return text;
}

/** Parse a tool call's raw arguments into the object the Messages wire expects. */
function parseInput(argumentsText: string): unknown {
  if (argumentsText === '') return {};
  try {
    return JSON.parse(argumentsText);
  } catch {
    return {};
  }
}

/** Read one Messages completion: SSE when the Gateway streams, JSON otherwise. */
async function readMessages(response: Response, request: ModelRequest, emit: AdapterEmit): Promise<Completion> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/event-stream')) return readJsonMessage(response, emit);
  return readStreamMessage(response, request, emit);
}

interface MessagesToolState {
  index: number;
  id: string;
  name: string;
  arguments: string;
  completed: boolean;
}

interface MessagesStreamState {
  text: string;
  reasoning: string;
  usage?: Usage;
  completed: boolean;
  finishReason?: FinishReason;
  tools: Map<number, MessagesToolState>;
  calls: ModelToolCall[];
  /** Response headers, so an in-stream error keeps the upstream retry hints. */
  headers: Headers;
  /** Shared protocol-neutral tokenizer_v1 collector for this attempt's stream. */
  tps: TpsGenerationCollector;
}

/** Collect a Messages SSE body. Only `message_stop` is terminal. */
async function readStreamMessage(response: Response, request: ModelRequest, emit: AdapterEmit): Promise<Completion> {
  const body = response.body;
  if (!body) throw new Error('Model response is missing a body');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const state: MessagesStreamState = { text: '', reasoning: '', completed: false, tools: new Map(), calls: [], headers: response.headers, tps: new TpsGenerationCollector() };
  let buffer = '';
  const onAbort = (): void => { void reader.cancel().catch(() => undefined); };
  if (request.signal.aborted) {
    await reader.cancel().catch(() => undefined);
    throw abortError();
  }
  request.signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (!state.completed) {
      // A stream read rejection is a transport I/O failure, not a parse failure;
      // a frame/JSON parse error below stays a protocol failure.
      const chunk = await reader.read().catch((error: unknown) => {
        throw networkError(error, request.signal);
      });
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n|\r(?!$)/gu, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        consumeFrame(frame, state, emit);
        if (state.completed) break;
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (!state.completed) {
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n?/gu, '\n');
      if (buffer.trim()) consumeFrame(buffer, state, emit);
    }
  } finally {
    request.signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
  }
  if (request.signal.aborted) throw abortError();
  if (!state.completed) throw incompleteStreamError();
  // Only `message_stop` is a successful completion; an errored or truncated
  // stream never reaches this point and yields no sample.
  const tps = state.tps.sample();
  return {
    text: state.text,
    ...(state.reasoning ? { reasoning: state.reasoning } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
    toolCalls: [...state.calls].sort((a, b) => a.index - b.index),
    ...(state.finishReason === undefined ? {} : { finishReason: state.finishReason }),
    ...(tps === undefined ? {} : { tps }),
  };
}

/** Consume one complete Messages SSE frame. */
function consumeFrame(frame: string, state: MessagesStreamState, emit: AdapterEmit): void {
  const dataLines = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart());
  if (dataLines.length === 0) return;
  const payload = dataLines.join('\n').trim();
  if (payload === '' || payload === '[DONE]') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error('Model stream returned invalid data');
  }
  const event = record(parsed);
  if (!event) return;
  const type = stringField(event.type);
  emit.activity();
  const at = Date.now();
  switch (type) {
    case 'message_start': {
      const message = record(event.message);
      applyInputUsage(record(message?.usage), state, emit);
      return;
    }
    case 'content_block_start': {
      const index = numberField(event.index) ?? state.tools.size;
      const block = record(event.content_block);
      if (block?.type === 'tool_use') {
        // A tool_use block begins output even before its argument deltas.
        emit.output();
        state.tools.set(index, {
          index,
          id: stringField(block.id) ?? `call_${index}`,
          name: stringField(block.name) ?? '',
          // The Messages stream starts `input` as `{}` and streams the JSON via deltas.
          arguments: '',
          completed: false,
        });
        return;
      }
      // Some blocks open with nonempty initial content; emit it as output.
      const initialText = stringField(block?.text);
      if (initialText) {
        state.text += initialText;
        emit.text(initialText);
      }
      const initialThinking = stringField(block?.thinking);
      if (initialThinking) {
        state.reasoning += initialThinking;
        emit.reasoning(initialThinking);
      }
      return;
    }
    case 'content_block_delta': {
      const index = numberField(event.index) ?? 0;
      const delta = record(event.delta);
      const deltaType = delta ? stringField(delta.type) : undefined;
      if (deltaType === 'text_delta') {
        const text = stringField(delta?.text);
        if (text) {
          state.text += text;
          emit.text(text);
          state.tps.observe(`text:${index}`, text, at);
        }
      } else if (deltaType === 'thinking_delta') {
        const thinking = stringField(delta?.thinking);
        if (thinking) {
          state.reasoning += thinking;
          emit.reasoning(thinking);
          state.tps.observe(`thinking:${index}`, thinking, at);
        }
      } else if (deltaType === 'input_json_delta') {
        const piece = stringField(delta?.partial_json);
        if (piece) {
          emit.output();
          // Every real argument fragment is generation and is fed exactly once,
          // partitioned by block index, even before its tool block is tracked.
          state.tps.observe(`tool:${index}`, piece, at);
          const tool = state.tools.get(index);
          if (tool) tool.arguments += piece;
        }
      }
      return;
    }
    case 'content_block_stop': {
      completeTool(numberField(event.index) ?? 0, state, emit);
      return;
    }
    case 'message_delta': {
      const delta = record(event.delta);
      const stopReason = delta ? stringField(delta.stop_reason) : undefined;
      if (stopReason !== undefined) state.finishReason = finishReasonOf(stopReason, state.calls.length);
      applyOutputUsage(record(event.usage), state, emit);
      return;
    }
    case 'message_stop': {
      state.completed = true;
      // Only `message_stop` is the Messages protocol's successful completion.
      state.tps.complete();
      return;
    }
    case 'error': {
      // Only `type:error` carrying an official error object with type/message is
      // an official Messages error.
      const official = isOfficialMessagesError(event);
      const identity = official ? upstreamErrorIdentity(event) : {};
      throw streamError({
        kind: official ? classifyOfficialError(identity.type, identity.code) : 'protocol',
        message: describeFailure(record(event.error) ?? event, 'Model request failed'),
        upstream: identity,
        headers: state.headers,
      });
    }
    default:
      return;
  }
}

/** Report one tool call at `index` exactly once. */
function completeTool(index: number, state: MessagesStreamState, emit: AdapterEmit): void {
  const tool = state.tools.get(index);
  if (!tool || tool.completed) return;
  tool.completed = true;
  const call: ModelToolCall = {
    index,
    id: tool.id,
    name: tool.name,
    arguments: tool.arguments,
    ...parseToolArguments(tool.arguments),
  };
  state.calls.push(call);
  emit.toolCall(call);
}

/**
 * Unified Messages input usage. Anthropic's `input_tokens` excludes cached
 * tokens, so the total input (the session cache-hit denominator) sums
 * `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`;
 * cache reads remain the cache-hit numerator.
 */
function inputUsageOf(raw: Record<string, unknown> | undefined): Usage | undefined {
  if (!raw) return undefined;
  const inputTokens = numberField(raw.input_tokens);
  const cacheRead = numberField(raw.cache_read_input_tokens);
  const cacheCreation = numberField(raw.cache_creation_input_tokens);
  if (inputTokens === undefined && cacheRead === undefined && cacheCreation === undefined) return undefined;
  return {
    input: (inputTokens ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0),
    ...(cacheRead === undefined ? {} : { cachedInput: cacheRead }),
  };
}

/** Official Messages error: `type:error` with an error object carrying string type and message. */
function isOfficialMessagesError(root: Record<string, unknown>): boolean {
  if (stringField(root.type) !== 'error') return false;
  const errorObj = record(root.error);
  return errorObj !== undefined && stringField(errorObj.type) !== undefined && stringField(errorObj.message) !== undefined;
}

/** Apply Messages input usage (total input and cache reads). */
function applyInputUsage(raw: Record<string, unknown> | undefined, state: MessagesStreamState, emit: AdapterEmit): void {
  const usage = inputUsageOf(raw);
  if (!usage) return;
  state.usage = { ...state.usage, ...usage };
  emit.usage(state.usage);
}

/** Apply Messages output usage (output tokens). */
function applyOutputUsage(raw: Record<string, unknown> | undefined, state: MessagesStreamState, emit: AdapterEmit): void {
  if (!raw) return;
  const output = numberField(raw.output_tokens);
  if (output === undefined) return;
  state.usage = { ...state.usage, output };
  emit.usage(state.usage);
}

/** Non-stream fallback: one complete Messages payload. */
async function readJsonMessage(response: Response, emit: AdapterEmit): Promise<Completion> {
  const payload = await response.json().catch((error: unknown) => { if (error instanceof SyntaxError) return undefined; throw error; });
  const root = record(payload);
  if (!root) throw new Error('Model response was not valid JSON');
  if (isOfficialMessagesError(root)) {
    const identity = upstreamErrorIdentity(root);
    throw streamError({ kind: classifyOfficialError(identity.type, identity.code), message: describeFailure(record(root.error) ?? root, 'Model request failed'), upstream: identity, headers: response.headers });
  }

  let text = '';
  let reasoning = '';
  const calls: ModelToolCall[] = [];
  const content = root.content;
  if (Array.isArray(content)) {
    content.forEach((entry, position) => {
      const block = record(entry);
      if (!block) return;
      const type = stringField(block.type);
      if (type === 'text') {
        const piece = stringField(block.text);
        if (piece) { text += piece; emit.text(piece); }
        return;
      }
      if (type === 'thinking') {
        const piece = stringField(block.thinking);
        if (piece) { reasoning += piece; emit.reasoning(piece); }
        return;
      }
      if (type === 'tool_use') {
        const argumentsText = JSON.stringify(block.input ?? {});
        const call: ModelToolCall = {
          index: position,
          id: stringField(block.id) ?? `call_${position}`,
          name: stringField(block.name) ?? '',
          arguments: argumentsText,
          ...parseToolArguments(argumentsText),
        };
        calls.push(call);
        emit.toolCall(call);
      }
    });
  }

  const usage = record(root.usage);
  const mapped = usage ? jsonUsageOf(usage) : undefined;
  if (mapped) emit.usage(mapped);

  const stopReason = stringField(root.stop_reason);
  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    ...(mapped ? { usage: mapped } : {}),
    toolCalls: calls,
    finishReason: finishReasonOf(stopReason, calls.length),
  };
}

/** Map a non-stream Messages usage object, summing the cache fields into total input. */
function jsonUsageOf(raw: Record<string, unknown>): Usage | undefined {
  const input = inputUsageOf(raw);
  const output = numberField(raw.output_tokens);
  const usage: Usage = {
    ...(input === undefined ? {} : input),
    ...(output === undefined ? {} : { output }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

/** Map the Messages `stop_reason` onto the normalized finish reason. */
function finishReasonOf(raw: string | undefined, toolCallCount: number): FinishReason {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence': return toolCallCount > 0 ? 'tool_calls' : 'stop';
    case 'max_tokens': return 'length';
    case 'tool_use': return 'tool_calls';
    case 'refusal': return 'content_filter';
    default: return toolCallCount > 0 ? 'tool_calls' : 'stop';
  }
}
