import { SseDataReader } from './sse.ts';
import type { ResponseObserver } from './protocols/types.ts';

export interface GatewayUsage { input?: number; output?: number; cachedInput?: number; reasoning?: number; }

type Row = Record<string, unknown>;

/**
 * One entry protocol's usage field accessors and its own completion / failure
 * markers. The observer itself is protocol-agnostic: every protocol branch
 * lives in the module that declares it.
 */
export interface UsageAdapter {
  input(raw: Row): number | undefined;
  output(raw: Row): number | undefined;
  cachedInput(raw: Row): number | undefined;
  reasoning(raw: Row): number | undefined;
  /** The usage object carried by this record, when there is one. */
  usage(row: Row): Row | undefined;
  /** True when this record successfully completes the response. */
  terminal(row: Row): boolean;
  /**
   * True when a raw (non-JSON) SSE data payload is this protocol's successful
   * completion sentinel, e.g. Chat's `[DONE]`. Protocols whose completion is a
   * JSON event return false and report it through {@link terminal}.
   */
  sentinel(payload: string): boolean;
  /** True when this record reports a failure. */
  failure(row: Row): boolean;
  /**
   * The official error identity this record carries, when it is an official
   * error frame for the protocol. `undefined` when the record is not an error
   * frame; `{}` when it is one but exposes no usable `type`/`code`. The frame
   * bytes are never rewritten — this is observation only.
   */
  errorIdentity(row: Row): { type?: string; code?: string } | undefined;
  /**
   * True when this record carries actual generation output: non-empty content,
   * reasoning or tool-call argument text on one of the protocol's emitted
   * channels. Declaring it also opts the protocol into the empty-completion
   * check: a terminal stream that produced no output of any kind and reported
   * no positive output tokens is not a success.
   */
  emitted?(row: Row): boolean;
}

/**
 * Passive observer of one successful-status response: records the usage the
 * upstream reported (absent fields stay absent, nothing is estimated), whether
 * the response reached a protocol completion without an error record, and the
 * official error identity when an official error frame was seen. All
 * protocol-specific interpretation is delegated to the {@link UsageAdapter}.
 */
export class ResponseUsageObserver {
  private readonly usage: GatewayUsage = {};
  private readonly reader = new SseDataReader(payload => this.consumeEvent(payload));
  private terminal = false;
  private failed = false;
  private streamed = false;
  private outputSeen = false;
  private observedError?: { type?: string; code?: string };

  constructor(private readonly adapter: UsageAdapter) {}

  /** A non-stream JSON body is complete by itself. */
  json(value: unknown): void { this.consume(value); this.terminal = true; }
  feed(chunk: string): void { this.reader.feed(chunk); }
  end(): void { this.reader.end(); }

  /**
   * A successful response completed without an error and, for a streamed
   * response from a protocol that observes generation output, produced some:
   * at least one emitted channel carried text or the usage reported positive
   * output tokens. An empty terminal stream is not a success — it must be
   * recorded as a route fault instead. A non-stream body is complete by itself.
   */
  succeeded(): boolean {
    return this.terminal && !this.failed
      && (this.adapter.emitted === undefined || !this.streamed || this.outputSeen || (this.usage.output ?? 0) > 0);
  }
  failedStream(): boolean { return this.failed; }
  /**
   * True when a protocol that observes generation output saw this stream reach
   * completion with no output of any kind. It is the fail-closed view of a
   * terminal response that {@link succeeded} refuses to accept.
   */
  emptyCompletion(): boolean {
    return this.terminal && !this.failed && this.adapter.emitted !== undefined && !this.succeeded();
  }
  result(): GatewayUsage | undefined { return Object.keys(this.usage).length ? { ...this.usage } : undefined; }
  error(): { type?: string; code?: string } | undefined {
    return this.observedError === undefined ? undefined : { ...this.observedError };
  }

  private consumeEvent(payload: string): void {
    this.streamed = true;
    // A protocol that terminates with a raw non-JSON sentinel owns that
    // recognition; the shared observer only records the outcome.
    if (this.adapter.sentinel(payload)) { this.terminal = true; return; }
    try { this.consume(JSON.parse(payload)); } catch { this.failed = true; }
  }

  private consume(value: unknown): void {
    const row = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Row
      : undefined;
    if (!row) return;
    if (this.adapter.failure(row)) this.failed = true;
    if (this.observedError === undefined) {
      const identity = this.adapter.errorIdentity(row);
      if (identity !== undefined) this.observedError = identity;
    }
    if (this.adapter.terminal(row)) this.terminal = true;
    if (this.adapter.emitted?.(row) === true) this.outputSeen = true;
    const raw = this.adapter.usage(row);
    if (!raw) return;
    const fields: GatewayUsage = {
      input: this.adapter.input(raw),
      output: this.adapter.output(raw),
      cachedInput: this.adapter.cachedInput(raw),
      reasoning: this.adapter.reasoning(raw),
    };
    for (const [key, amount] of Object.entries(fields) as [keyof GatewayUsage, number | undefined][]) {
      if (amount !== undefined) this.usage[key] = amount;
    }
  }
}

/**
 * True when the observer saw a streamed response reach completion with no
 * output of any kind. Only a protocol whose adapter observes generation output
 * can report it; every other protocol and every non-stream body returns false.
 */
export function completedWithoutOutput(observer: ResponseObserver): boolean {
  return observer instanceof ResponseUsageObserver && observer.emptyCompletion();
}
