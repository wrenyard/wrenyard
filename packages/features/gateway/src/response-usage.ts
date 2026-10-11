import { SseDataReader } from './sse.ts';

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
  private observedError?: { type?: string; code?: string };

  constructor(private readonly adapter: UsageAdapter) {}

  /** A non-stream JSON body is complete by itself. */
  json(value: unknown): void { this.consume(value); this.terminal = true; }
  feed(chunk: string): void { this.reader.feed(chunk); }
  end(): void { this.reader.end(); }

  succeeded(): boolean { return this.terminal && !this.failed; }
  result(): GatewayUsage | undefined { return Object.keys(this.usage).length ? { ...this.usage } : undefined; }
  error(): { type?: string; code?: string } | undefined {
    return this.observedError === undefined ? undefined : { ...this.observedError };
  }

  private consumeEvent(payload: string): void {
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
