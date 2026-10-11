/**
 * Span recording for model requests.
 *
 * One span is one unit of delegated work: a reasoning request, or one whole
 * auxiliary task however many requests it takes. The model request executor
 * reports every request it issues; this recorder turns those reports into
 * exactly one `span.started` and one `span.finished` per span id, summing the
 * measured metrics of a multi-request task.
 *
 * A single-request span closes as soon as its request reports. A loop holds its
 * span open across rounds and releases it when the task ends, so whatever was
 * measured before a failure or an interrupt is still written.
 */
import type { ModelSpanFinishedEvent, ModelSpanStartedEvent, SpanStatus } from '../ledger/events.ts';
import type { ModelMetrics, Usage } from '../transport/protocol.ts';

export type ModelSpanDraft =
  | Omit<ModelSpanStartedEvent, 'seq' | 'at'>
  | Omit<ModelSpanFinishedEvent, 'seq' | 'at'>;

interface OpenSpan {
  held: boolean;
  started: boolean;
  /** The latest finish report, with metrics summed over every report so far. */
  last?: Omit<ModelSpanFinishedEvent, 'seq' | 'at'>;
}

export class SpanRecorder {
  private readonly spans = new Map<string, OpenSpan>();

  constructor(private readonly append: (draft: ModelSpanDraft) => void | Promise<void>) {}

  /** The sink the model request executor reports each request to. */
  readonly report = async (draft: ModelSpanDraft): Promise<void> => {
    const span = this.spans.get(draft.id) ?? { held: false, started: false };
    this.spans.set(draft.id, span);
    if (draft.type === 'span.started') {
      // Later rounds of a held span reuse the span opened by the first one.
      if (span.started) return;
      span.started = true;
      await this.append(draft);
      return;
    }
    const metrics = sumMetrics(span.last?.metrics, draft.metrics);
    span.last = { ...draft, ...(metrics === undefined ? {} : { metrics }) };
    if (!span.held) await this.close(draft.id, span);
  };

  /** Keep a span open across several requests until {@link release}. */
  hold(id: string): void {
    const span = this.spans.get(id) ?? { held: false, started: false };
    span.held = true;
    this.spans.set(id, span);
  }

  /** Close a held span with everything measured so far; a span that never ran writes nothing. */
  async release(id: string, status?: SpanStatus): Promise<void> {
    const span = this.spans.get(id);
    if (span === undefined) return;
    if (span.last !== undefined && status !== undefined) span.last = { ...span.last, status };
    await this.close(id, span);
  }

  private async close(id: string, span: OpenSpan): Promise<void> {
    this.spans.delete(id);
    if (span.last === undefined) return;
    await this.append(span.last);
  }
}

/** Sum two metric records; the first-output wait is the first request's. */
function sumMetrics(total: ModelMetrics | undefined, next: ModelMetrics | undefined): ModelMetrics | undefined {
  if (total === undefined) return next;
  if (next === undefined) return total;
  const usage = sumUsage(total.usage, next.usage);
  const streamMs = add(total.streamMs, next.streamMs);
  const streamTokens = add(total.streamTokens, next.streamTokens);
  const responseModel = next.responseModel ?? total.responseModel;
  const finishReason = next.finishReason ?? total.finishReason;
  const ttftMs = total.ttftMs ?? next.ttftMs;
  return {
    ...(responseModel === undefined ? {} : { responseModel }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(usage === undefined ? {} : { usage }),
    ...(ttftMs === undefined ? {} : { ttftMs }),
    ...(streamMs === undefined ? {} : { streamMs }),
    ...(streamTokens === undefined ? {} : { streamTokens }),
    attempts: [...total.attempts, ...next.attempts],
  };
}

function sumUsage(total: Usage | undefined, next: Usage | undefined): Usage | undefined {
  if (total === undefined) return next;
  if (next === undefined) return total;
  const sum: Usage = {};
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens'] as const) {
    const value = add(total[key], next[key]);
    if (value !== undefined) sum[key] = value;
  }
  return sum;
}

function add(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
}
