/**
 * Response-paired gateway TPS sampler.
 *
 * Observes an OpenAI chat-completions SSE body and produces at most one sample
 * per upstream response: the exact response id, the canonical response model,
 * the upstream-reported completion tokens, the timestamp of the first nonempty
 * generated delta, and the timestamp of the terminal finish_reason. Tokens are
 * never estimated; a sample exists only when the stream completed successfully
 * with a valid terminal marker and a usage report.
 *
 * The clock is injected so sampling is deterministic under test.
 */
export interface ResponseTpsSample {
  response_id: string;
  model: string;
  output_tokens: number;
  first_token_at_ms: number;
  completed_at_ms: number;
}

export interface ResponseTpsContract {
  tps_sampling_contract: 'response_v1';
  tps_samples: ResponseTpsSample[];
}

export interface ResponseSamplerOptions {
  now?: () => number;
  /** Canonicalizes an upstream response model id to the public model id. */
  normalizeModel?: (model: string) => string;
}

interface Usage {
  completionTokens?: number;
}

/** Accumulates one SSE response; state is discarded when the stream is not a fully successful completion. */
export class ResponseSampler {
  private readonly now: () => number;
  private readonly normalizeModel: (model: string) => string;

  private model: string | undefined;
  private responseId: string | undefined;
  private firstDeltaAtMs: number | undefined;
  private completedAtMs: number | undefined;
  private usage: Usage | undefined;
  private sawData = false;
  private sawDone = false;
  private failed = false;
  private usageConflict = false;
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

  /** Emits the contract only when the whole stream was a successful complete response. */
  sample(): ResponseTpsContract | undefined {
    if (!this.sawData || this.failed || this.sawNonStreamJson) return undefined;
    if (!this.sawDone) return undefined;
    if (this.usageConflict || this.modelConflict || this.idConflict) return undefined;
    if (this.responseId === undefined || this.model === undefined) return undefined;
    if (this.firstDeltaAtMs === undefined || this.completedAtMs === undefined) return undefined;
    if (!Number.isFinite(this.firstDeltaAtMs) || this.firstDeltaAtMs <= 0) return undefined;
    if (!Number.isFinite(this.completedAtMs) || this.completedAtMs <= this.firstDeltaAtMs) return undefined;
    const completionTokens = this.usage?.completionTokens;
    if (completionTokens === undefined || !Number.isSafeInteger(completionTokens) || completionTokens <= 0) {
      return undefined;
    }
    return {
      tps_sampling_contract: 'response_v1',
      tps_samples: [{
        response_id: this.responseId,
        model: this.model,
        output_tokens: completionTokens,
        first_token_at_ms: this.firstDeltaAtMs,
        completed_at_ms: this.completedAtMs,
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

    const usage = asRecord(record.usage);
    if (usage && Object.prototype.hasOwnProperty.call(usage, 'completion_tokens')) {
      const completion = usage.completion_tokens;
      // The reported completion count is authoritative and never rounded; a
      // fractional, negative, or unsafe value fails the whole response.
      if (typeof completion !== 'number' || !Number.isSafeInteger(completion) || completion < 0) {
        this.failed = true;
      } else if (this.usage?.completionTokens === undefined) {
        this.usage = { completionTokens: completion };
      } else if (this.usage.completionTokens !== completion) {
        this.usageConflict = true;
      }
    }

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
      const delta = asRecord(choiceRecord.delta);
      if (delta && hasNonemptyDelta(delta) && this.firstDeltaAtMs === undefined) {
        this.firstDeltaAtMs = this.now();
      }
      if (finish !== undefined && finish !== null && finish !== '') {
        if (this.completedAtMs === undefined) this.completedAtMs = this.now();
      }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasNonemptyDelta(delta: Record<string, unknown>): boolean {
  const content = delta.content;
  if (typeof content === 'string' && content !== '') return true;
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') return true;
  if (typeof delta.reasoning === 'string' && delta.reasoning !== '') return true;
  const toolCalls = delta.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      const callRecord = asRecord(call);
      const fn = asRecord(callRecord?.function);
      const args = fn?.arguments;
      if (typeof args === 'string' && args !== '') return true;
    }
  }
  return false;
}
