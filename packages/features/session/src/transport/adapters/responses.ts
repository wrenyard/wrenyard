/**
 * OpenAI Responses protocol adapter.
 *
 * Implements the {@link ProtocolAdapter} contract on the official Responses API
 * (`POST {openaiResponsesBaseUrl}/responses`). One call is one stateless
 * streaming completion: the system message becomes `instructions`, the user
 * messages become the `input` items in order, and every declared tool is sent
 * as a flattened function tool. It owns no retry and performs no fetch.
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

/** Hard byte cap for one serialized Responses request body (64 MiB). */
export const RESPONSES_REQUEST_MAX_BYTES = 64 * 1024 * 1024;

export const responsesAdapter: ProtocolAdapter = {
  protocol: 'openai_responses',
  label: 'Responses request',
  maxBytes: RESPONSES_REQUEST_MAX_BYTES,
  url: (endpoints: GatewayEndpoints): string => `${endpoints.responses.replace(/\/+$/u, '')}/responses`,
  serialize: serializeResponsesRequest,
  read: readResponses,
};

/** Serialize the exact Responses body. */
export function serializeResponsesRequest(request: ModelRequest): string {
  return JSON.stringify(buildResponsesBody(request));
}

function buildResponsesBody(request: ModelRequest): Record<string, unknown> {
  const systems: Message[] = [];
  const rest: Message[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') systems.push(message);
    else rest.push(message);
  }
  if (systems.length > 1) throw new Error('Responses request accepts at most one system message');
  if (!rest.some((message) => message.role === 'user')) throw new Error('Responses request requires a user message');

  // With several messages, a trailing user message is the per-request closing message.
  const closing = rest.length > 1 && rest.at(-1)!.role === 'user' ? rest.length - 1 : -1;
  const body: Record<string, unknown> = {
    model: request.model,
    input: rest.flatMap((message, index) => inputItems(message, index === closing)),
    stream: true,
    store: false,
  };
  if (systems.length === 1) body.instructions = plainText(systems[0]!.content);
  // The summary is the only reasoning text the protocol exposes; request it so
  // the thinking channel is filled whenever the model reasons. The reasoning
  // level itself travels in the request header, never as a body `effort`.
  body.reasoning = { summary: 'auto' };
  if (request.cacheKey) body.prompt_cache_key = request.cacheKey;
  if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
  if (request.tools !== undefined && request.tools.length > 0) {
    // The Responses tool shape is a flattened function, not the nested chat shape.
    body.tools = request.tools.map((tool: ToolSpec) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    // An unspecified choice defaults to `auto`. The supported internal forms map
    // onto the official Responses shapes; an unsupported value is a hard error
    // rather than a silently wrong mapping.
    body.tool_choice = responsesToolChoice(request.toolChoice);
  }
  return body;
}

/** Serialize one toolbox choice in the Responses `tool_choice` shape. */
function responsesToolChoice(choice: ToolChoice | undefined): unknown {
  if (choice === undefined || choice === 'auto') return 'auto';
  if (choice === 'none') return 'none';
  if (choice === 'required') return 'required';
  if (typeof choice === 'object' && typeof choice.name === 'string') {
    return { type: 'function', name: choice.name };
  }
  throw new Error('Unsupported tool choice for the Responses protocol');
}

/** The Responses input items of one message. */
function inputItems(message: Message, closing: boolean): Record<string, unknown>[] {
  if (message.role === 'assistant') {
    const text = plainText(message.content);
    return [
      ...(text === '' ? [] : [{ role: 'assistant', content: [{ type: 'output_text', text }] }]),
      ...(message.toolCalls ?? []).map((call) => ({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    ];
  }
  if (message.role === 'tool') {
    return [{ type: 'function_call_output', call_id: message.toolCallId, output: plainText(message.content) }];
  }
  return [{ role: closing ? 'developer' : 'user', content: userContent(message.content) }];
}

/** Map one user content value onto Responses `input_text`/`input_image` parts. */
function userContent(content: string | ModelContentPart[]): Record<string, unknown>[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  return content.map((part) => part.type === 'text'
    ? { type: 'input_text', text: part.text }
    : { type: 'input_image', image_url: part.image_url.url });
}

/** The plain string of a text-only message; an image part is an error. */
function plainText(content: string | ModelContentPart[]): string {
  if (typeof content === 'string') return content;
  let text = '';
  for (const part of content) {
    if (part.type !== 'text') throw new Error('Responses text message cannot contain an image part');
    text += part.text;
  }
  return text;
}

/** Read one Responses completion: SSE when the Gateway streams, JSON otherwise. */
async function readResponses(response: Response, request: ModelRequest, emit: AdapterEmit): Promise<Completion> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/event-stream')) return readJsonResponse(response, emit);
  return readStreamResponse(response, request, emit);
}

interface FunctionCallState {
  outputIndex: number;
  /** The item id used to match streamed delta events. */
  itemId?: string;
  /** The official `call_id` to replay; distinct from the item id. */
  callId?: string;
  name: string;
  arguments: string;
  reported: boolean;
}

interface ResponsesStreamState {
  text: string;
  reasoning: string;
  usage?: Usage;
  completed: boolean;
  finishReason?: FinishReason;
  calls: ModelToolCall[];
  byIndex: Map<number, FunctionCallState>;
  byItemId: Map<string, FunctionCallState>;
  /** Response headers, so an in-stream error keeps the upstream retry hints. */
  headers: Headers;
  /** Shared protocol-neutral tokenizer_v1 collector for this attempt's stream. */
  tps: TpsGenerationCollector;
}

/** Collect a Responses SSE body. Only `response.completed` is terminal. */
async function readStreamResponse(response: Response, request: ModelRequest, emit: AdapterEmit): Promise<Completion> {
  const body = response.body;
  if (!body) throw new Error('Model response is missing a body');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const state: ResponsesStreamState = {
    text: '',
    reasoning: '',
    completed: false,
    calls: [],
    byIndex: new Map(),
    byItemId: new Map(),
    headers: response.headers,
    tps: new TpsGenerationCollector(),
  };
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
  // Only `response.completed` is a successful completion; a failed, incomplete,
  // errored or truncated stream never reaches this point and yields no sample.
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

/**
 * The stable output-item identity of one Responses event, matching the Gateway's
 * TPS channel partitioning: the item id when present, otherwise the numeric
 * output index.
 */
function tpsItemKey(event: Record<string, unknown>): string {
  const itemId = stringField(event.item_id);
  if (itemId !== undefined) return itemId;
  const outputIndex = numberField(event.output_index);
  if (outputIndex !== undefined) return String(Math.trunc(outputIndex));
  return '0';
}

/** A finite numeric index as a stable channel fragment, defaulting to `0`. */
function tpsIndexKey(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.trunc(value)) : '0';
}

/** Consume one complete Responses SSE frame. */
function consumeFrame(frame: string, state: ResponsesStreamState, emit: AdapterEmit): void {
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
  emit.activity();
  const at = Date.now();
  const type = stringField(event.type);
  switch (type) {
    case 'response.output_text.delta': {
      const delta = stringField(event.delta);
      if (delta) {
        state.text += delta;
        emit.text(delta);
        state.tps.observe(`output_text:${tpsItemKey(event)}:${tpsIndexKey(event.content_index)}`, delta, at);
      }
      return;
    }
    case 'response.reasoning_summary_text.delta': {
      const delta = stringField(event.delta);
      if (delta) {
        state.reasoning += delta;
        emit.reasoning(delta);
        state.tps.observe(`reasoning_summary:${tpsItemKey(event)}:${tpsIndexKey(event.summary_index)}`, delta, at);
      }
      return;
    }
    case 'response.reasoning_text.delta': {
      const delta = stringField(event.delta);
      if (delta) {
        state.reasoning += delta;
        emit.reasoning(delta);
        // Displayed reasoning is never counted as output content.
        state.tps.observe(`reasoning_text:${tpsItemKey(event)}`, delta, at);
      }
      return;
    }
    case 'response.output_item.added': {
      if (record(event.item)?.type === 'function_call') emit.output();
      registerFunctionCall(event.item, event.output_index, state);
      return;
    }
    case 'response.function_call_arguments.delta': {
      if (stringField(event.delta)) emit.output();
      accumulateFunctionCall(event, state, at);
      return;
    }
    case 'response.output_item.done': {
      finishFunctionCall(event.item, event.output_index, state, emit);
      return;
    }
    case 'response.completed': {
      applyUsage(record(event.response)?.usage, state, emit);
      const responseValue = record(event.response);
      state.finishReason = finishReasonOf(record(responseValue?.incomplete_details), state.calls.length);
      state.completed = true;
      // Only `response.completed` is the Responses protocol's success marker.
      state.tps.complete();
      return;
    }
    case 'response.failed':
    case 'response.incomplete': {
      const failed = record(event.response);
      applyUsage(failed?.usage, state, emit);
      const identity = upstreamErrorIdentity(failed);
      throw streamError({
        kind: classifyOfficialError(identity.type, identity.code),
        message: describeFailedResponse(failed, 'Model request failed'),
        upstream: identity,
        headers: state.headers,
      });
    }
    case 'error': {
      const identity = upstreamErrorIdentity(event);
      throw streamError({ kind: classifyOfficialError(identity.type, identity.code), message: describeFailure(event, 'Model request failed'), upstream: identity, headers: state.headers });
    }
    default:
      return;
  }
}

/** Register a streamed function call under its output index and item id. */
function registerFunctionCall(rawItem: unknown, rawIndex: unknown, state: ResponsesStreamState): void {
  const item = record(rawItem);
  if (!item || item.type !== 'function_call') return;
  const outputIndex = numberField(rawIndex) ?? numberField(item.output_index) ?? state.byIndex.size;
  // Track by the item id (matching `item_id` on delta events); keep the official
  // `call_id` separately for replay.
  const trackedId = stringField(item.id);
  const callId = stringField(item.call_id);
  const call: FunctionCallState = state.byIndex.get(outputIndex)
    ?? { outputIndex, name: '', arguments: '', reported: false };
  const name = stringField(item.name);
  if (name !== undefined) call.name = name;
  if (trackedId !== undefined) {
    call.itemId = trackedId;
    state.byItemId.set(trackedId, call);
  }
  if (callId !== undefined) call.callId = callId;
  const initial = stringField(item.arguments);
  if (initial !== undefined) call.arguments = initial;
  state.byIndex.set(outputIndex, call);
}

/** Append one `function_call_arguments.delta` fragment to its tracked call. */
function accumulateFunctionCall(event: Record<string, unknown>, state: ResponsesStreamState, at: number): void {
  const piece = stringField(event.delta) ?? '';
  // Every raw argument fragment is generation and is fed to the sampler exactly
  // once, keyed by the stable function-item identity, independent of whether the
  // call is already tracked. A snapshot or completed arguments is never a delta.
  if (piece !== '') state.tps.observe(`tool:${tpsItemKey(event)}`, piece, at);
  const outputIndex = numberField(event.output_index);
  const itemId = stringField(event.item_id);
  const call = (itemId !== undefined ? state.byItemId.get(itemId) : undefined)
    ?? (outputIndex !== undefined ? state.byIndex.get(outputIndex) : undefined);
  if (!call) return;
  call.arguments += piece;
  if (outputIndex !== undefined) state.byIndex.set(outputIndex, call);
  if (itemId !== undefined) state.byItemId.set(itemId, call);
}

/** Report a function call once its `output_item.done` frame arrives. */
function finishFunctionCall(rawItem: unknown, rawIndex: unknown, state: ResponsesStreamState, emit: AdapterEmit): void {
  const item = record(rawItem);
  if (!item || item.type !== 'function_call') return;
  const outputIndex = numberField(rawIndex) ?? numberField(item.output_index) ?? state.byIndex.size;
  const trackedId = stringField(item.id);
  const callId = stringField(item.call_id);
  let call = (trackedId !== undefined ? state.byItemId.get(trackedId) : undefined) ?? state.byIndex.get(outputIndex);
  if (!call) {
    call = { outputIndex, name: '', arguments: '', reported: false };
  }
  const name = stringField(item.name);
  if (name !== undefined) call.name = name;
  const finalArguments = stringField(item.arguments);
  if (finalArguments !== undefined) call.arguments = finalArguments;
  if (trackedId !== undefined) {
    call.itemId = trackedId;
    state.byItemId.set(trackedId, call);
  }
  if (callId !== undefined) call.callId = callId;
  state.byIndex.set(outputIndex, call);
  reportFunctionCall(call, state, emit);
}

/** Parse and report one completed function call exactly once. */
function reportFunctionCall(call: FunctionCallState, state: ResponsesStreamState, emit: AdapterEmit): void {
  if (call.reported) return;
  call.reported = true;
  const argumentsText = call.arguments;
  const parsed: ModelToolCall = {
    index: call.outputIndex,
    // The official call id is replayed when the stream provided one, matching
    // the non-stream JSON path.
    id: call.callId ?? call.itemId ?? `call_${call.outputIndex}`,
    name: call.name,
    arguments: argumentsText,
    ...parseToolArguments(argumentsText),
  };
  state.calls.push(parsed);
  emit.toolCall(parsed);
}

/** Live usage of one event, present only when upstream actually reported it. */
function applyUsage(raw: unknown, state: ResponsesStreamState, emit: AdapterEmit): void {
  const usage = usageOf(raw);
  if (!usage) return;
  state.usage = { ...state.usage, ...usage };
  emit.usage(state.usage);
}

/** Map a Responses usage object onto the optional {@link Usage} fields. */
function usageOf(root: unknown): Usage | undefined {
  const raw = record(root);
  if (!raw) return undefined;
  const input = numberField(raw.input_tokens);
  const output = numberField(raw.output_tokens);
  const inputDetails = record(raw.input_tokens_details);
  const outputDetails = record(raw.output_tokens_details);
  const cachedInput = inputDetails ? numberField(inputDetails.cached_tokens) : undefined;
  const reasoning = outputDetails ? numberField(outputDetails.reasoning_tokens) : undefined;
  const usage: Usage = {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

/** Non-stream fallback: one complete Responses payload. */
async function readJsonResponse(response: Response, emit: AdapterEmit): Promise<Completion> {
  const payload = await response.json().catch((error: unknown) => { if (error instanceof SyntaxError) return undefined; throw error; });
  const root = record(payload);
  if (!root) throw new Error('Model response was not valid JSON');
  // Only a non-null official error object is an error; `error: null` is not.
  const errorObj = record(root.error);
  if (errorObj) {
    const identity = upstreamErrorIdentity(root);
    throw streamError({ kind: classifyOfficialError(identity.type, identity.code), message: describeFailure(errorObj, 'Model request failed'), upstream: identity, headers: response.headers });
  }
  const status = stringField(root.status);
  if (status === 'failed' || status === 'incomplete') {
    const identity = upstreamErrorIdentity(root);
    throw streamError({ kind: classifyOfficialError(identity.type, identity.code), message: describeFailedResponse(root, 'Model request failed'), upstream: identity, headers: response.headers });
  }

  let text = '';
  let reasoning = '';
  const calls: ModelToolCall[] = [];
  const output = root.output;
  if (Array.isArray(output)) {
    output.forEach((entry, position) => {
      const item = record(entry);
      if (!item) return;
      const type = stringField(item.type);
      if (type === 'message') {
        for (const part of arrayOfRecords(item.content)) {
          if (part.type !== 'output_text') continue;
          const piece = stringField(part.text);
          if (piece) {
            text += piece;
            emit.text(piece);
          }
        }
        return;
      }
      if (type === 'reasoning') {
        for (const part of arrayOfRecords(item.summary)) {
          const piece = stringField(part.text);
          if (piece) {
            reasoning += piece;
            emit.reasoning(piece);
          }
        }
        return;
      }
      if (type === 'function_call') {
        const argumentsText = stringField(item.arguments) ?? '';
        const call: ModelToolCall = {
          index: position,
          id: stringField(item.call_id) ?? stringField(item.id) ?? `call_${position}`,
          name: stringField(item.name) ?? '',
          arguments: argumentsText,
          ...parseToolArguments(argumentsText),
        };
        calls.push(call);
        emit.toolCall(call);
      }
    });
  }

  const usage = usageOf(root.usage);
  if (usage) emit.usage(usage);
  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    ...(usage ? { usage } : {}),
    toolCalls: calls,
    finishReason: finishReasonOf(record(root.incomplete_details), calls.length),
  };
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const records: Record<string, unknown>[] = [];
  for (const entry of value) {
    const item = record(entry);
    if (item) records.push(item);
  }
  return records;
}

/** Human-readable failure message of a failed/incomplete Responses payload. */
function describeFailedResponse(response: Record<string, unknown> | undefined, fallback: string): string {
  if (!response) return fallback;
  const errorObj = record(response.error);
  if (errorObj) return describeFailure(errorObj, fallback);
  const details = record(response.incomplete_details);
  const reason = details ? stringField(details.reason) : undefined;
  if (reason) return `Model response was incomplete: ${reason}`;
  const status = stringField(response.status);
  return status ? `Model response ${status}` : fallback;
}

/** Map a Responses completion onto the normalized finish reason. */
function finishReasonOf(incompleteDetails: Record<string, unknown> | undefined, toolCallCount: number): FinishReason {
  const reason = incompleteDetails ? stringField(incompleteDetails.reason) : undefined;
  if (reason !== undefined) return reason.includes('max_output') || reason.includes('length') ? 'length' : 'stop';
  return toolCallCount > 0 ? 'tool_calls' : 'stop';
}
