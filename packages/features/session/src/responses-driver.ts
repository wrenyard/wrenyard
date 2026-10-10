/**
 * OpenAI Responses inference adapter.
 *
 * Implements the in-process {@link ModelDriver} port on the official Responses
 * API (`POST {openaiResponsesBaseUrl}/responses`). One call is one stateless
 * streaming completion: the system message becomes `instructions`, the user
 * messages become the `input` items in order, and every declared tool is sent
 * as a flattened function tool whose calls are reported through the generic
 * {@link ToolCall} shape.
 *
 * The protocol caches implicitly at the end of the latest user message and
 * looks back over earlier user-message endings. The caller supplies user
 * messages that only ever grow by appending, followed by one closing message
 * that changes per request; sending that closing message as a `developer` item
 * leaves the cache point at the end of the appended context. The request is
 * never stored upstream (`store: false`, no `previous_response_id`).
 */
import type { WrenyardGatewayConnection } from '@wrenyard/control';

import {
  describeFailure,
  numberField,
  record,
  stringField,
  type DriverRequest,
  type DriverResult,
  type ModelContentPart,
  type ModelDriver,
  type ModelMessage,
  type ToolCall,
  type ToolSpec,
  type Usage,
} from './driver.ts';
import { abortError, IncompleteStreamError, postToGateway } from './transport.ts';

export interface ResponsesDriverOptions {
  fetch?: typeof fetch;
}

/** The subset of a driver request that is serialized onto the Responses wire. */
export type ResponsesRequestFields = Pick<DriverRequest, 'model' | 'messages' | 'maxTokens' | 'tools' | 'cacheKey'> & Partial<Pick<DriverRequest, 'reasoningEffort'>>;

/** Hard byte cap for one serialized Responses request body (64 MiB). */
export const RESPONSES_REQUEST_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Serialize the exact Responses body `complete` sends. A caller can use this to
 * preflight the byte cap before issuing the request, without guessing any
 * provider-specific limit.
 */
export function serializeResponsesRequest(request: ResponsesRequestFields): string {
  return JSON.stringify(buildResponsesBody(request));
}

function buildResponsesBody(request: ResponsesRequestFields): Record<string, unknown> {
  const systems: ModelMessage[] = [];
  const rest: ModelMessage[] = [];
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
  if (request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens;
  if (request.tools !== undefined && request.tools.length > 0) {
    // The Responses tool shape is a flattened function, not the nested chat shape.
    body.tools = request.tools.map((tool: ToolSpec) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
  return body;
}

/** The Responses input items of one message. */
function inputItems(message: ModelMessage, closing: boolean): Record<string, unknown>[] {
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

/** Responses-backed streaming driver. */
export function createResponsesDriver(
  connection: WrenyardGatewayConnection,
  options: ResponsesDriverOptions = {},
): ModelDriver {
  return {
    complete: (request) => postToGateway({
      connection,
      fetch: options.fetch ?? globalThis.fetch,
      url: `${connection.openaiResponsesBaseUrl.replace(/\/+$/u, '')}/responses`,
      body: () => serializeResponsesRequest(request),
      maxBytes: RESPONSES_REQUEST_MAX_BYTES,
      label: 'Responses request',
      read: readResponses,
    }, request),
  };
}

/**
 * Read one Responses completion. The API streams SSE for `stream: true`, but a
 * gateway that ignores the flag still answers with an ordinary JSON response,
 * so both shapes are accepted.
 */
async function readResponses(response: Response, request: DriverRequest): Promise<DriverResult> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/event-stream')) {
    return readJsonResponse(response, request);
  }
  return readStreamResponse(response, request);
}

/** One streamed function call, accumulated under both its output index and item id. */
interface FunctionCallState {
  outputIndex: number;
  itemId?: string;
  name: string;
  arguments: string;
  reported: boolean;
}

interface ResponsesStreamState {
  text: string;
  reasoning: string;
  usage?: Usage;
  /** Saw `response.completed`, the only terminal event. */
  completed: boolean;
  calls: ToolCall[];
  byIndex: Map<number, FunctionCallState>;
  byItemId: Map<string, FunctionCallState>;
}

/**
 * Collect a Responses SSE body. `response.output_text.delta` is visible text,
 * `response.reasoning_summary_text.delta` feeds the reasoning channel, and
 * native function calls are accumulated from `output_item.added` plus
 * `function_call_arguments.delta` until `output_item.done` reports each call
 * exactly once. Split frames, split multi-byte characters and CRLF are carried
 * across chunks. Only `response.completed` is terminal: a `response.failed` /
 * `response.incomplete` / error frame or an EOF before completion is a failure,
 * an abort throws immediately, and the reader and abort listener are always
 * released.
 */
async function readStreamResponse(response: Response, request: DriverRequest): Promise<DriverResult> {
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
        if (state.completed) break;
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (!state.completed) {
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n?/gu, '\n');
      if (buffer.trim()) consumeStreamFrame(buffer, request, state);
    }
  } finally {
    request.signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
  }
  if (request.signal.aborted) throw abortError();
  if (!state.completed) throw new IncompleteStreamError();
  return {
    text: state.text,
    ...(state.reasoning ? { reasoning: state.reasoning } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
    toolCalls: [...state.calls].sort((a, b) => a.index - b.index),
  };
}

/**
 * Consume one complete SSE frame. Multi-line `data:` fields are joined before
 * parsing, matching the event-stream grammar; only the declared Responses event
 * types are acted on.
 */
function consumeStreamFrame(frame: string, request: DriverRequest, state: ResponsesStreamState): void {
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
  request.onActivity?.();
  const type = stringField(event.type);
  switch (type) {
    case 'response.output_text.delta': {
      const delta = stringField(event.delta);
      if (delta) {
        state.text += delta;
        request.onText?.(delta);
      }
      return;
    }
    case 'response.reasoning_summary_text.delta': {
      const delta = stringField(event.delta);
      if (delta) {
        state.reasoning += delta;
        request.onReasoning?.(delta);
      }
      return;
    }
    // A started function call is generated output before it completes.
    case 'response.output_item.added': {
      if (record(event.item)?.type === 'function_call') request.onOutput?.();
      registerFunctionCall(event.item, event.output_index, state);
      return;
    }
    case 'response.function_call_arguments.delta': {
      if (stringField(event.delta)) request.onOutput?.();
      accumulateFunctionCall(event, state);
      return;
    }
    case 'response.output_item.done': {
      finishFunctionCall(event.item, event.output_index, state, request);
      return;
    }
    case 'response.completed': {
      applyUsage(record(event.response)?.usage, request, state);
      state.completed = true;
      return;
    }
    case 'response.failed':
    case 'response.incomplete': {
      const failed = record(event.response);
      applyUsage(failed?.usage, request, state);
      throw new Error(describeFailedResponse(failed, 'Model request failed'));
    }
    case 'error': {
      throw new Error(describeFailure(event, 'Model request failed'));
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
  const itemId = stringField(item.id) ?? stringField(item.call_id);
  const call: FunctionCallState = state.byIndex.get(outputIndex)
    ?? { outputIndex, name: '', arguments: '', reported: false };
  const name = stringField(item.name);
  if (name !== undefined) call.name = name;
  if (itemId !== undefined) {
    call.itemId = itemId;
    state.byItemId.set(itemId, call);
  }
  const initial = stringField(item.arguments);
  if (initial !== undefined) call.arguments = initial;
  state.byIndex.set(outputIndex, call);
}

/** Append one `function_call_arguments.delta` fragment to its tracked call. */
function accumulateFunctionCall(event: Record<string, unknown>, state: ResponsesStreamState): void {
  const outputIndex = numberField(event.output_index);
  const itemId = stringField(event.item_id);
  const call = (itemId !== undefined ? state.byItemId.get(itemId) : undefined)
    ?? (outputIndex !== undefined ? state.byIndex.get(outputIndex) : undefined);
  if (!call) return;
  call.arguments += stringField(event.delta) ?? '';
  if (outputIndex !== undefined) state.byIndex.set(outputIndex, call);
  if (itemId !== undefined) state.byItemId.set(itemId, call);
}

/** Report a function call once its `output_item.done` frame arrives. */
function finishFunctionCall(rawItem: unknown, rawIndex: unknown, state: ResponsesStreamState, request: DriverRequest): void {
  const item = record(rawItem);
  if (!item || item.type !== 'function_call') return;
  const outputIndex = numberField(rawIndex) ?? numberField(item.output_index) ?? state.byIndex.size;
  const itemId = stringField(item.id) ?? stringField(item.call_id);
  let call = (itemId !== undefined ? state.byItemId.get(itemId) : undefined) ?? state.byIndex.get(outputIndex);
  if (!call) {
    call = { outputIndex, name: '', arguments: '', reported: false };
  }
  const name = stringField(item.name);
  if (name !== undefined) call.name = name;
  const finalArguments = stringField(item.arguments);
  if (finalArguments !== undefined) call.arguments = finalArguments;
  if (itemId !== undefined) {
    call.itemId = itemId;
    state.byItemId.set(itemId, call);
  }
  state.byIndex.set(outputIndex, call);
  reportFunctionCall(call, state, request);
}

/**
 * Parse and report one completed function call exactly once, generically over
 * its tool name. The raw id, name and argument text are reported unchanged so
 * the caller can classify the call.
 */
function reportFunctionCall(call: FunctionCallState, state: ResponsesStreamState, request: DriverRequest): void {
  if (call.reported) return;
  call.reported = true;
  request.onOutput?.();
  const parsed: ToolCall = {
    index: call.outputIndex,
    id: call.itemId ?? `call_${call.outputIndex}`,
    name: call.name,
    arguments: call.arguments,
  };
  state.calls.push(parsed);
  request.onToolCall?.(parsed);
}

/** Live usage of one event, present only when upstream actually reported it. */
function applyUsage(raw: unknown, request: DriverRequest, state: ResponsesStreamState): void {
  const usage = usageOf(raw);
  if (!usage) return;
  state.usage = { ...state.usage, ...usage };
  request.onUsage?.(state.usage);
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
async function readJsonResponse(response: Response, request: DriverRequest): Promise<DriverResult> {
  const payload = await response.json().catch((error: unknown) => { if (error instanceof SyntaxError) return undefined; throw error; });
  const root = record(payload);
  if (!root) throw new Error('Model response was not valid JSON');
  if (root.error !== undefined) throw new Error(describeFailure(root.error, 'Model request failed'));
  const status = stringField(root.status);
  if (status === 'failed' || status === 'incomplete') {
    throw new Error(describeFailedResponse(root, 'Model request failed'));
  }

  let text = '';
  let reasoning = '';
  const calls: ToolCall[] = [];
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
            request.onText?.(piece);
          }
        }
        return;
      }
      if (type === 'reasoning') {
        for (const part of arrayOfRecords(item.summary)) {
          const piece = stringField(part.text);
          if (piece) {
            reasoning += piece;
            request.onReasoning?.(piece);
          }
        }
        return;
      }
      if (type === 'function_call') {
        const call: ToolCall = {
          index: position,
          id: stringField(item.call_id) ?? stringField(item.id) ?? `call_${position}`,
          name: stringField(item.name) ?? '',
          arguments: stringField(item.arguments) ?? '',
        };
        calls.push(call);
        request.onToolCall?.(call);
      }
    });
  }

  const usage = usageOf(root.usage);
  if (usage) request.onUsage?.(usage);
  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    ...(usage ? { usage } : {}),
    toolCalls: calls,
  };
}

/** Human-readable failure message of a failed/incomplete Responses payload. */
function describeFailedResponse(response: Record<string, unknown> | undefined, fallback: string): string {
  if (!response) return fallback;
  if (response.error !== undefined) return describeFailure(response.error, fallback);
  const details = record(response.incomplete_details);
  const reason = details ? stringField(details.reason) : undefined;
  if (reason) return `Model response was incomplete: ${reason}`;
  const status = stringField(response.status);
  return status ? `Model response ${status}` : fallback;
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
