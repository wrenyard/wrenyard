/**
 * Approximate gateway TPS sampler.
 *
 * Observes an OpenAI chat-completions SSE body and produces at most one
 * approximate speed sample per upstream response. Output tokens are counted
 * with a fixed cl100k_base tokenizer over only the generation content that was
 * actually observed on the wire: assistant text, visible reasoning, and tool
 * call arguments. Each content channel (text, reasoning) and each tool
 * argument block is accumulated and tokenized once as a whole, so the count is
 * independent of how the stream was segmented into deltas or network chunks.
 * The generation interval runs from the first nonempty delta arrival to the
 * last nonempty delta arrival, so completion latency, trailing usage events,
 * and anything after the last generated token never inflate the denominator.
 *
 * A sample exists only when the response completed successfully: error
 * records, malformed events, data after [DONE], conflicting response ids or
 * models, truncated streams, and multi-choice responses yield no sample.
 * Official usage and
 * billing are never read or altered by this contract.
 *
 * The clock is injected so sampling is deterministic under test.
 */
import { getEncoding } from 'js-tiktoken';

/** Minimum observable generation span for a trustworthy speed sample. */
const MINIMUM_WINDOW_MS = 100;

/** Fixed tokenizer, created lazily on the first sample. */
let tokenizer: ReturnType<typeof getEncoding> | undefined;

/** Counts text as ordinary text: special-token lookalikes never throw. */
function countTokens(text: string): number {
  if (text === '') return 0;
  tokenizer ??= getEncoding('cl100k_base');
  return tokenizer.encode(text, [], []).length;
}

export interface ResponseTpsSample {
  response_id: string;
  model: string;
  /** cl100k_base approximation over observed generation content only. */
  output_tokens: number;
  first_token_at_ms: number;
  completed_at_ms: number;
}

export interface ResponseTpsContract {
  tps_sampling_contract: 'tokenizer_v1';
  tps_samples: ResponseTpsSample[];
}

export interface ResponseSamplerOptions {
  now?: () => number;
  /** Canonicalizes an upstream response model id to the public model id. */
  normalizeModel?: (model: string) => string;
}

/** Accumulates one SSE response; state is discarded when the stream is not a fully successful completion. */
export class ResponseSampler {
  private readonly now: () => number;
  private readonly normalizeModel: (model: string) => string;

  private model: string | undefined;
  private responseId: string | undefined;
  private firstDeltaAtMs: number | undefined;
  private lastDeltaAtMs: number | undefined;
  private readonly deltaTimestamps = new Set<number>();
  /** Concatenated per-channel generation content; tokenized once at sample time. */
  private textContent = '';
  private reasoningContent = '';
  private readonly toolArguments = new Map<string, string>();
  private sawData = false;
  private sawDone = false;
  private failed = false;
  private modelConflict = false;
  private idConflict = false;
  private sawNonStreamJson = false;
  private readonly observedIds = new Set<string>();
  private readonly observedModels = new Set<string>();

  constructor(options: ResponseSamplerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.normalizeModel = options.normalizeModel ?? ((model) => model);
  }

  /** Marks a non-event-stream (JSON or opaque) body; such responses yield no sample. */
  markNonStream(): void {
    this.sawNonStreamJson = true;
  }

  /** Feeds one raw upstream chunk. Handles arbitrary fragmentation and multiline SSE. */
  feed(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  }

  /** Flushes any trailing buffered line at end of stream. */
  end(): void {
    if (this.buffer) {
      const line = this.buffer;
      this.buffer = '';
      this.consumeLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    // An event left open without its blank separator still terminates the stream.
    this.flushEvent();
  }

  /** Emits the contract when the response succeeded and its window is observable. */
  sample(): ResponseTpsContract | undefined {
    if (!this.sawData || !this.sawDone || this.failed || this.sawNonStreamJson) return undefined;
    if (this.idConflict || this.modelConflict) return undefined;
    if (this.responseId === undefined || this.model === undefined) return undefined;
    if (this.firstDeltaAtMs === undefined || this.lastDeltaAtMs === undefined) return undefined;
    // A fully buffered or otherwise single-timestamp window carries no timing signal.
    if (this.deltaTimestamps.size < 2) return undefined;
    const windowMs = this.lastDeltaAtMs - this.firstDeltaAtMs;
    if (!Number.isFinite(windowMs) || windowMs < MINIMUM_WINDOW_MS) return undefined;
    const outputTokens = countTokens(this.textContent) + countTokens(this.reasoningContent)
      + [...this.toolArguments.values()].reduce((sum, args) => sum + countTokens(args), 0);
    if (!Number.isSafeInteger(outputTokens) || outputTokens <= 0) {
      return undefined;
    }
    return {
      tps_sampling_contract: 'tokenizer_v1',
      tps_samples: [{
        response_id: this.responseId,
        model: this.model,
        output_tokens: outputTokens,
        first_token_at_ms: this.firstDeltaAtMs,
        completed_at_ms: this.lastDeltaAtMs,
      }],
    };
  }

  private buffer = '';
  /** Data lines of the currently open SSE event, joined at the blank separator. */
  private readonly dataLines: string[] = [];

  private consumeLine(line: string): void {
    if (line === '') { this.flushEvent(); return; }
    if (line.startsWith(':')) return;
    const fieldMatch = /^data:\s?(.*)$/u.exec(line);
    if (fieldMatch) this.dataLines.push(fieldMatch[1]!);
  }

  /** Parses one complete SSE event's joined data lines, if any. */
  private flushEvent(): void {
    if (this.dataLines.length === 0) return;
    const payload = this.dataLines.join('\n');
    this.dataLines.length = 0;
    if (payload === '[DONE]') {
      this.sawDone = true;
      return;
    }
    // Any further data after the terminal marker invalidates the response.
    if (this.sawDone) {
      this.failed = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A malformed data line invalidates the response; never sample a partial.
      this.failed = true;
      return;
    }
    this.sawData = true;
    const record = asRecord(parsed);
    if (!record) {
      this.failed = true;
      return;
    }
    if (record.error !== undefined && record.error !== null) {
      this.failed = true;
      return;
    }

    const id = record.id;
    if (typeof id === 'string' && id !== '') {
      if (this.responseId === undefined) this.responseId = id;
      this.observedIds.add(id);
      if (this.observedIds.size > 1) this.idConflict = true;
    }

    const model = record.model;
    if (typeof model === 'string' && model !== '') {
      const normalized = this.normalizeModel(model);
      if (this.model === undefined) this.model = normalized;
      this.observedModels.add(normalized);
      if (this.observedModels.size > 1) this.modelConflict = true;
    }

    // Official usage passes through untouched; it is never a sampling input.

    // Only a single-choice response has an attributable generation interval.
    if (Array.isArray(record.choices) && record.choices.length > 1) {
      this.failed = true;
      return;
    }
    const choices = Array.isArray(record.choices) ? record.choices : [];
    for (const choice of choices) {
      const choiceRecord = asRecord(choice);
      if (!choiceRecord) {
        this.failed = true;
        continue;
      }
      if (choiceRecord.index !== undefined && choiceRecord.index !== 0) {
        this.failed = true;
        continue;
      }
      const finish = choiceRecord.finish_reason;
      if (finish === 'error' || finish === 'content_filter') {
        this.failed = true;
        continue;
      }
      this.observeDelta(asRecord(choiceRecord.delta));
    }
  }

  /** Accumulates one delta's observed generation content and its arrival time. */
  private observeDelta(delta: Record<string, unknown> | undefined): void {
    if (!delta) return;
    let observed = false;

    const content = delta.content;
    if (typeof content === 'string' && content !== '') {
      this.textContent += content;
      observed = true;
    }

    // Only visible reasoning streams here; hidden reasoning and summaries are
    // never observed on these channels and so are never counted.
    for (const field of ['reasoning_content', 'reasoning'] as const) {
      const value = delta[field];
      if (typeof value === 'string' && value !== '') {
        this.reasoningContent += value;
        observed = true;
      }
    }

    const toolCalls = delta.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const callRecord = asRecord(call);
        const args = asRecord(callRecord?.function)?.arguments;
        // A tool call without streamed arguments contributes no tokens.
        if (typeof args !== 'string' || args === '') continue;
        const index = callRecord?.index;
        const key = typeof index === 'number'
          ? `index:${index}`
          : typeof callRecord?.id === 'string' && callRecord.id !== '' ? `id:${callRecord.id}` : 'index:0';
        this.toolArguments.set(key, (this.toolArguments.get(key) ?? '') + args);
        observed = true;
      }
    }

    if (observed) {
      const atMs = this.now();
      this.firstDeltaAtMs ??= atMs;
      this.lastDeltaAtMs = atMs;
      this.deltaTimestamps.add(atMs);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
