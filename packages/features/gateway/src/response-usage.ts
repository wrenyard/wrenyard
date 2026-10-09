import type { GatewayProtocol } from '@wrenyard/providers/catalog';
import { SseDataReader } from './sse.ts';

export interface GatewayUsage { input?: number; output?: number; cachedInput?: number; reasoning?: number; }

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * Passive observer of one successful-status response: records the usage the
 * upstream reported (absent fields stay absent, nothing is estimated) and
 * whether the response reached a protocol completion without an error record.
 */
export class ResponseUsageObserver {
  private readonly usage: GatewayUsage = {};
  private readonly reader = new SseDataReader(payload => this.consumeEvent(payload));
  private terminal = false;
  private failed = false;

  constructor(private readonly protocol: GatewayProtocol) {}

  /** A non-stream JSON body is complete by itself. */
  json(value: unknown): void { this.consume(value); this.terminal = true; }
  feed(chunk: string): void { this.reader.feed(chunk); }
  end(): void { this.reader.end(); }

  succeeded(): boolean { return this.terminal && !this.failed; }
  result(): GatewayUsage | undefined { return Object.keys(this.usage).length ? { ...this.usage } : undefined; }

  private consumeEvent(payload: string): void {
    if (payload === '[DONE]') { this.terminal = true; return; }
    try { this.consume(JSON.parse(payload)); } catch { this.failed = true; }
  }

  private consume(value: unknown): void {
    const row = object(value);
    if (!row) return;
    const response = object(row.response);
    if (row.error || row.type === 'error' || row.type === 'response.failed' || row.type === 'response.incomplete'
      || response?.error || response?.status === 'failed' || response?.status === 'incomplete') this.failed = true;
    if (row.type === 'response.completed' || row.type === 'message_stop') this.terminal = true;
    if (Array.isArray(row.choices)) {
      const reasons = row.choices.map(choice => object(choice)?.finish_reason);
      if (reasons.some(reason => reason === 'error' || reason === 'content_filter')) this.failed = true;
      if (reasons.some(reason => reason != null)) this.terminal = true;
    }
    const raw = object(row.usage) ?? object(response?.usage) ?? object(object(row.message)?.usage);
    if (!raw) return;
    const chat = this.protocol === 'openai_chat';
    const fields: GatewayUsage = {
      input: count(chat ? raw.prompt_tokens : raw.input_tokens),
      output: count(chat ? raw.completion_tokens : raw.output_tokens),
      cachedInput: count(this.protocol === 'anthropic_messages'
        ? raw.cache_read_input_tokens
        : object(raw.prompt_tokens_details ?? raw.input_tokens_details)?.cached_tokens),
      reasoning: count(object(raw.completion_tokens_details ?? raw.output_tokens_details)?.reasoning_tokens),
    };
    for (const [key, amount] of Object.entries(fields) as [keyof GatewayUsage, number | undefined][]) {
      if (amount !== undefined) this.usage[key] = amount;
    }
  }
}
