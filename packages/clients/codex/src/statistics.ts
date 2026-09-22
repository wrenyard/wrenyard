import { performance } from 'node:perf_hooks';
import { TokenizerGeneration, attachTpsSamples } from '@wrenyard/agent-client/statistics';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const integer = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
type Usage = { input_tokens: number; output_tokens: number; cached_input_tokens: number; total_tokens: number };
function usage(value: unknown): Usage | undefined {
    const source = row(value);
    const input = integer(source.inputTokens ?? source.input_tokens);
    const output = integer(source.outputTokens ?? source.output_tokens);
    const cached = integer(source.cachedInputTokens ?? source.cached_input_tokens) ?? 0;
    const total = integer(source.totalTokens ?? source.total_tokens) ?? ((input ?? 0) + (output ?? 0));
    return input === undefined || output === undefined ? undefined : { input_tokens: input, output_tokens: output, cached_input_tokens: cached, total_tokens: total };
}

/** Native response boundaries pair streamed generation windows with tokenizer_v1. */
export class CodexStatistics {
    private readonly anchor = Date.now() - performance.now();
    private raw = new TokenizerGeneration();
    private summary = new TokenizerGeneration();
    private rawReasoning = false;
    private readonly seen = new Set<string>();
    private readonly samples: Array<{ response_id: string; model: string; output_tokens: number; first_token_at_ms: number; completed_at_ms: number }> = [];
    private totals: Usage | undefined;
    private baseline: Usage | undefined;
    constructor(private readonly model: string, private readonly resumed: boolean) {}

    observe(method: string, params: Row): void {
        if (method === 'item/agentMessage/delta' || method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
            const text = typeof params.delta === 'string' ? params.delta : row(params.delta).text;
            if (typeof text !== 'string' || !text) return;
            const at = Math.floor(this.anchor + performance.now());
            const key = `${method}/${String(params.itemId ?? params.item_id ?? '')}/${String(params.summaryIndex ?? '')}`;
            // Keep two windows: raw reasoning supersedes its rendered summary.
            if (method === 'item/reasoning/textDelta') this.rawReasoning = true;
            if (method !== 'item/reasoning/summaryTextDelta') this.raw.observe(key, text, at);
            if (method !== 'item/reasoning/textDelta') this.summary.observe(key, text, at);
            return;
        }
        if (method === 'rawResponse/completed' && !this.resumed) {
            const id = params.responseId ?? params.response_id;
            if (typeof id !== 'string' || !id) { this.reset(); return; }
            if (this.seen.has(id)) return;
            this.seen.add(id);
            this.add(usage(params.usage));
            this.complete(id);
        }
        if (method === 'thread/tokenUsage/updated' && this.resumed) {
            const value = row(params.tokenUsage);
            const total = usage(value.total);
            const last = usage(value.last);
            if (!total) { this.baseline = undefined; this.reset(); return; }
            const previous = this.baseline;
            this.baseline = total;
            if (!previous) { this.reset(); return; }
            const keys = Object.keys(total) as Array<keyof Usage>;
            if (keys.every(key => total[key] === previous[key])) return;
            if (!last || !keys.every(key => total[key] - previous[key] === last[key])) { this.reset(); return; }
            this.add(last);
            this.complete(`codex-resume:${String(params.threadId)}:${String(params.turnId)}:${total.total_tokens}`);
        }
    }

    finish(success: boolean): Row | undefined {
        const data: Row = { type: 'turn_usage', ...(this.totals ?? {}) };
        if (success) attachTpsSamples(data, this.samples);
        return this.totals || (success && this.samples.length) ? data : undefined;
    }
    private add(value: Usage | undefined): void {
        if (!value) return;
        this.totals ??= { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, total_tokens: 0 };
        for (const key of Object.keys(value) as Array<keyof Usage>) this.totals[key] += value[key];
    }
    private complete(id: string): void {
        const measured = (this.rawReasoning ? this.raw : this.summary).measure();
        if (measured) this.samples.push({ response_id: id, model: this.model, output_tokens: measured.tokens, first_token_at_ms: measured.first_token_at_ms, completed_at_ms: measured.completed_at_ms });
        this.reset();
    }
    private reset(): void {
        this.raw = new TokenizerGeneration();
        this.summary = new TokenizerGeneration();
        this.rawReasoning = false;
    }
}
