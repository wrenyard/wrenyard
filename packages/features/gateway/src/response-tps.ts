/**
 * Gateway bridge between a protocol module's translated generation signals and
 * the shared tokenizer speed sample core in `@wrenyard/agent-client/statistics`.
 *
 * All wire recognition lives in the protocol modules; this bridge only accepts
 * protocol-neutral channel deltas and a successful-completion / failure signal,
 * counts each concatenated channel once through the shared core, and preserves
 * the Gateway's existing `tps_samples` wire contract. It never
 * parses a protocol event.
 *
 * The clock is injected so sampling is deterministic under test.
 */
import { TpsGenerationCollector, sampleTiming, type AggregatedResponseTpsSample } from '@wrenyard/agent-client/statistics';
import type { TpsSink } from './protocols/types.ts';

export interface ResponseTpsSample {
  response_id: string;
  model: string;
  /** o200k_base approximation over observed generation content only. */
  output_tokens: number;
  first_token_at_ms: number;
  completed_at_ms: number;
}

export interface ResponseTpsContract {
  /** One window as the scalar pair; interrupted visible streaming as a window vector. */
  tps_samples: (ResponseTpsSample | AggregatedResponseTpsSample)[];
}

export interface ResponseSamplerOptions {
  now?: () => number;
  /** The canonical public model id this response was requested as. */
  model?: string;
}

/**
 * Consumes the protocol-neutral signals of one upstream response and emits the
 * Gateway's tokenizer speed sample. It is the sink a protocol module's
 * `TpsTranslator` writes into.
 */
export class ResponseSampler implements TpsSink {
  private readonly now: () => number;
  private readonly model: string;
  private readonly collector = new TpsGenerationCollector();
  private responseId: string | undefined;

  constructor(options: ResponseSamplerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.model = options.model ?? '';
  }

  /** One nonempty generation delta on a stable, distinct channel. */
  delta(channel: string, text: string): void {
    if (text === '') return;
    this.collector.observe(channel, text, this.now());
  }

  /** The protocol's successful completion, carrying the upstream response id when observed. */
  complete(responseId?: string): void {
    if (typeof responseId === 'string' && responseId !== '') this.responseId = responseId;
    this.collector.complete();
  }

  /** An error, cancellation, or truncation: no sample is ever produced. */
  fail(): void {
    this.collector.fail();
  }

  /** The stream ended; a stream that never completed successfully is truncated. */
  end(): void {
    if (!this.collector.settled) this.collector.fail();
  }

  /** Emits the unchanged wire contract when a valid, completed window exists. */
  sample(): ResponseTpsContract | undefined {
    const measured = this.collector.sample();
    if (!measured || this.responseId === undefined || this.model === '') return undefined;
    return {
      tps_samples: [{
        response_id: this.responseId,
        model: this.model,
        output_tokens: measured.outputTokens,
        ...sampleTiming({ tokens: measured.outputTokens, windows: measured.windows }),
      }],
    };
  }
}
