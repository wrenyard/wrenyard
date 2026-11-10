/**
 * Shared tokenizer speed sample primitives.
 *
 * Every client decoder that can observe a client's own partial stream uses
 * these primitives so the persisted sample means exactly one thing: a fixed,
 * embedded o200k_base tokenizer counted over ONLY the generation content that
 * was actually observed streaming, divided by that content's own
 * first-to-last nonempty delta window.
 *
 * Official usage and billing are never read, replaced, or altered here, and a
 * sample is never fabricated: a window that never spanned the minimum
 * observable interval (a buffered or collapsed stream) is skipped, not
 * extrapolated, and the whole-turn wall clock is never a denominator.
 */
import o200k_base from 'gpt-tokenizer/encoding/o200k_base';

/** Minimum observable generation span for a trustworthy speed sample. */
export const TOKENIZER_MINIMUM_WINDOW_MS = 100;

/** One timing shape: a scalar first-token-to-completion window. */
export interface ResponseTpsSample {
    response_id: string;
    model: string;
    output_tokens: number;
    first_token_at_ms: number;
    completed_at_ms: number;
}

/** One observed serial model-generation interval inside a larger turn. */
export interface GenerationWindow {
    tokens: number;
    first_token_at_ms: number;
    completed_at_ms: number;
}

/**
 * Aggregated timing shape: serial generation windows whose aggregate token
 * count is the sample's output_tokens. Ingestion requires exactly one timing
 * shape per sample, so a sample carries either the scalar fields or windows.
 */
export interface AggregatedResponseTpsSample {
    response_id: string;
    model: string;
    output_tokens: number;
    generation_windows: GenerationWindow[];
    /** When the request started, so a first-token latency can be derived. */
    request_started_at_ms?: number;
}

/** Fixed tokenizer, created lazily on first use and shared process-wide. */
let tokenizer: typeof o200k_base | undefined;

/**
 * Counts text as ordinary text with the fixed o200k_base vocabulary, so a
 * special-token lookalike in model output can never throw. Returns undefined
 * when the tokenizer cannot be constructed, which makes the caller skip the
 * sample instead of reporting a partial count.
 */
export function countTPSTokens(text: string): number | undefined {
    if (text === '') return 0;
    tokenizer ??= o200k_base;
    return tokenizer.encode(text, { allowedSpecial: new Set(), disallowedSpecial: new Set() }).length;
}

/** One measured generation: its counted tokens and the windows they streamed in. */
export interface MeasuredGeneration {
    tokens: number;
    /** Ordered, non-overlapping intervals during which visible content was streaming. */
    windows: GenerationWindow[];
}

/**
 * Accumulates one generation's streamed content, one block per content
 * channel, each with its own first and last nonempty delta arrival. Each block
 * is concatenated before encoding so the count never depends on how a client
 * splits its deltas.
 *
 * The measured time is the union of the blocks' own streaming intervals, not
 * one span from the first delta to the last: a stretch in which no visible
 * content arrives — hidden reasoning, or tool arguments a client never
 * surfaces — lies between blocks and is not counted as generation time for the
 * visible tokens. Completion latency is never part of the measurement either.
 */
export class TokenizerGeneration {
    private readonly blocks = new Map<string, { text: string; firstMS: number; lastMS: number }>();
    private lastMS = 0;
    private invalid = false;
    /** Records a nonempty delta of one content block; an empty delta is not generation activity. */
    observe(key: string, text: string, at: number): void {
        if (text === '') return;
        // A nonpositive or regressing boundary makes the window unmeasurable.
        if (!Number.isFinite(at) || at <= 0 || this.lastMS > at) {
            this.invalid = true;
            return;
        }
        const block = this.blocks.get(key);
        if (block) {
            block.text += text;
            block.lastMS = at;
        } else {
            this.blocks.set(key, { text, firstMS: at, lastMS: at });
        }
        this.lastMS = at;
    }
    /** True once any observed delta has poisoned the window. */
    get poisoned(): boolean {
        return this.invalid;
    }
    /**
     * Closes the measurement. A block that streamed for at least the minimum
     * observable span contributes its interval; overlapping intervals merge
     * into one window. A block delivered in a single burst has no interval of
     * its own: its tokens count only when the burst falls inside a window
     * another block opened, otherwise it is left out with no time attributed.
     * Undefined when nothing is measurable — poisoned, never started, no block
     * with an observable interval, uncountable, or zero tokens.
     */
    measure(): MeasuredGeneration | undefined {
        if (this.invalid || this.blocks.size === 0) return undefined;
        const blocks = [...this.blocks.values()];
        const spans = blocks
            .filter((block) => block.lastMS - block.firstMS >= TOKENIZER_MINIMUM_WINDOW_MS)
            .map((block) => ({ first: block.firstMS, last: block.lastMS }))
            .sort((a, b) => a.first - b.first);
        const merged: { first: number; last: number }[] = [];
        for (const span of spans) {
            const current = merged.at(-1);
            if (current && span.first <= current.last) current.last = Math.max(current.last, span.last);
            else merged.push({ ...span });
        }
        if (merged.length === 0) return undefined;
        const windows: GenerationWindow[] = merged.map((span) => ({ tokens: 0, first_token_at_ms: span.first, completed_at_ms: span.last }));
        let tokens = 0;
        for (const block of blocks) {
            const window = windows.find((entry) => block.firstMS >= entry.first_token_at_ms && block.lastMS <= entry.completed_at_ms);
            if (!window) continue;
            const count = countTPSTokens(block.text);
            if (count === undefined) return undefined;
            window.tokens += count;
            tokens += count;
        }
        if (!Number.isSafeInteger(tokens) || tokens <= 0) return undefined;
        return { tokens, windows };
    }
}

/**
 * The timing fields of a response sample for one measurement: the scalar
 * first/completed pair when the content streamed in one window, the
 * `generation_windows` vector when visible streaming was interrupted.
 */
export function sampleTiming(measured: MeasuredGeneration):
    | { first_token_at_ms: number; completed_at_ms: number }
    | { generation_windows: GenerationWindow[] } {
    const [only] = measured.windows;
    if (measured.windows.length === 1 && only) {
        return { first_token_at_ms: only.first_token_at_ms, completed_at_ms: only.completed_at_ms };
    }
    return { generation_windows: measured.windows.map((window) => ({ ...window })) };
}

/** The protocol-neutral TPS result of one successful streamed response. */
export interface TpsGenerationSample {
    outputTokens: number;
    /** Total time visible content was streaming, in milliseconds. */
    windowMs: number;
    /** The streaming windows `windowMs` sums. */
    windows: GenerationWindow[];
}

/**
 * Protocol-neutral TPS collector for one streamed response.
 *
 * A protocol adapter translates its own wire events into nonempty channel
 * deltas plus one terminal signal: `complete` on the protocol's successful
 * completion, `fail` on any error, cancellation, or truncated stream. Each
 * channel's deltas are concatenated and tokenized once by the shared
 * tokenizer speed sample rule, and the window is the first to last nonempty delta. A
 * sample is produced only for a completed, non-failed response whose window
 * spans at least the minimum observable interval and counts at least one
 * token, so buffered or collapsed streams, single-timestamp windows, sub-100ms
 * windows, and zero-token responses are skipped rather than extrapolated. This
 * is the single sampling core the Gateway and the session transport share; no
 * second tokenizer or algorithm exists.
 */
export class TpsGenerationCollector {
    private readonly generation = new TokenizerGeneration();
    private completed = false;
    private failed = false;

    /** Records a nonempty delta of one content channel; an empty delta is not generation activity. */
    observe(channel: string, text: string, at: number): void {
        if (text === '') return;
        // Generation received after the protocol's successful terminal marker
        // is not part of the measured window and can never enter a sample.
        if (this.completed) return;
        this.generation.observe(channel, text, at);
    }

    /** Marks the protocol's successful completion. */
    complete(): void {
        this.completed = true;
    }

    /** Marks an error, cancellation, or truncation: no sample is ever produced. */
    fail(): void {
        this.failed = true;
    }

    /** True once either a successful completion or a failure has settled the response. */
    get settled(): boolean {
        return this.completed || this.failed;
    }

    /**
     * The single sample when the response completed and its window is
     * observable; undefined for failed, cancelled, truncated, buffered
     * (single-timestamp), sub-100ms, or zero-token responses.
     */
    sample(): TpsGenerationSample | undefined {
        if (!this.completed || this.failed) return undefined;
        const measured = this.generation.measure();
        if (!measured) return undefined;
        const windowMs = measured.windows.reduce((sum, window) => sum + (window.completed_at_ms - window.first_token_at_ms), 0);
        return { outputTokens: measured.tokens, windowMs, windows: measured.windows };
    }
}
