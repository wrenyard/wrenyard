/**
 * session-v2 model driver.
 *
 * A driver executes exactly one stateless streaming completion and returns the
 * visible text, the reasoning text and the provider usage. It owns no session
 * state: orchestration, timeouts, budget checks and the ledger live in
 * `calls.ts`. The only MVP implementation talks to the local Wrenyard Model
 * Gateway over its OpenAI-compatible chat endpoint.
 */
import type { WrenyardGatewayConnection } from '@wrenyard/control-client';

/** One chat message the driver accepts. The gateway contract has no tool role here. */
export interface ModelMessage {
  role: 'system' | 'user';
  content: string;
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
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** Latest upstream-reported usage, so a caller keeps it on a partial failure. */
  onUsage?: (usage: Usage) => void;
}

export interface DriverResult {
  text: string;
  reasoning?: string;
  usage?: Usage;
}

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
      const body: Record<string, unknown> = {
        model: request.model,
        messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
        stream: true,
        stream_options: { include_usage: true },
      };
      if (request.reasoningEffort) body[REASONING_EFFORT_FIELD] = request.reasoningEffort;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${connection.token}`,
          },
          body: JSON.stringify(body),
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
  const text = message ? stringField(message.content) ?? '' : '';
  const reasoning = message ? reasoningField(message) : undefined;
  if (text) request.onText?.(text);
  if (reasoning) request.onReasoning?.(reasoning);
  const { usage } = usageOf(root);
  if (usage) request.onUsage?.(usage);
  return { text, ...(reasoning ? { reasoning } : {}), ...(usage ? { usage } : {}) };
}

interface StreamState {
  text: string;
  reasoning: string;
  usage?: Usage;
  /** Saw `[DONE]`, which ends the read loop. */
  done: boolean;
  /** Saw a terminal indication (`[DONE]` or a `finish_reason`). */
  finished: boolean;
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
  const state: StreamState = { text: '', reasoning: '', done: false, finished: false };
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
  return {
    text: state.text,
    ...(state.reasoning ? { reasoning: state.reasoning } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
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

function abortError(): Error {
  const error = new Error('Model request was aborted');
  error.name = 'AbortError';
  return error;
}
