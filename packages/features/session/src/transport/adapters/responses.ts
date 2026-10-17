/**
 * OpenAI Responses protocol adapter.
 *
 * Implements the {@link ProtocolAdapter} contract on the official Responses API
 * (`POST {openaiResponsesBaseUrl}/responses`). One call is one stateless
 * streaming completion: the system message becomes `instructions`, the user
 * messages become the `input` items in order, and every declared tool is sent
 * as a flattened function tool. It owns no retry and performs no fetch.
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
  // An explicit Fast preference maps onto the official service tier. An absent
  // preference leaves the body untouched, so reasoning and cache fields below
  // are unaffected.
  if (request.fast !== undefined) body.service_tier = request.fast ? 'priority' : 'default';
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
}

/** Collect a Responses SSE body. Only `response.completed` is terminal. */
async function readResponses(response: Response, request: ModelRequest, emit: AdapterEmit): Promise<Completion> {
  const state: ResponsesStreamState = {
    text: '',
    reasoning: '',
    completed: false,
    calls: [],
    byIndex: new Map(),
    byItemId: new Map(),
    headers: response.headers,
  };
  await readSseStream(response, request.signal, (frame) => consumeFrame(frame, state, emit), () => state.completed);
  if (request.signal.aborted) throw abortError();
  if (!state.completed) throw incompleteStreamError();
  // Only `response.completed` is a successful completion; a failed, incomplete,
  // errored or truncated stream never reaches this point and yields no sample.
  return {
    text: state.text,
    ...(state.reasoning ? { reasoning: state.reasoning } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
    toolCalls: [...state.calls].sort((a, b) => a.index - b.index),
    ...(state.finishReason === undefined ? {} : { finishReason: state.finishReason }),
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
  const type = stringField(event.type);
  switch (type) {
    case 'response.output_text.delta': {
      const delta = stringField(event.delta);
      if (delta) {
        state.text += delta;
        emit.text(delta);
        emit.generation(`output_text:${tpsItemKey(event)}:${tpsIndexKey(event.content_index)}`, delta);
      }
      return;
    }
    case 'response.reasoning_summary_text.delta': {
      const delta = stringField(event.delta);
      if (delta) {
        state.reasoning += delta;
        emit.reasoning(delta);
        emit.generation(`reasoning_summary:${tpsItemKey(event)}:${tpsIndexKey(event.summary_index)}`, delta);
      }
      return;
    }
    case 'response.reasoning_text.delta': {
      const delta = stringField(event.delta);
      if (delta) {
        state.reasoning += delta;
        emit.reasoning(delta);
        // Displayed reasoning is never counted as output content.
        emit.generation(`reasoning_text:${tpsItemKey(event)}`, delta);
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
      accumulateFunctionCall(event, state, emit);
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
      emit.complete();
      return;
    }
    case 'response.failed':
    case 'response.incomplete': {
      const failed = record(event.response);
      applyUsage(failed?.usage, state, emit);
      const identity = upstreamErrorIdentity(failed);
      emit.fail();
      throw streamError({
        kind: classifyOfficialError(identity.type, identity.code),
        message: describeFailedResponse(failed, 'Model request failed'),
        upstream: identity,
        headers: state.headers,
      });
    }
    case 'error': {
      const identity = upstreamErrorIdentity(event);
      emit.fail();
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
function accumulateFunctionCall(event: Record<string, unknown>, state: ResponsesStreamState, emit: AdapterEmit): void {
  const piece = stringField(event.delta) ?? '';
  // Every raw argument fragment is generation and is fed to the sampler exactly
  // once, keyed by the stable function-item identity, independent of whether the
  // call is already tracked. A snapshot or completed arguments is never a delta.
  if (piece !== '') emit.generation(`tool:${tpsItemKey(event)}`, piece);
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
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(cachedInput === undefined ? {} : { cachedInputTokens: cachedInput }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
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
