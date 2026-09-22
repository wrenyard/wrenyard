/**
 * Shared tokenizer_v1 speed-sampling primitives.
 *
 * Every client decoder that can observe a client's own partial stream uses
 * these primitives so the persisted sample means exactly one thing: a fixed,
 * embedded cl100k_base tokenizer counted over ONLY the generation content that
 * was actually observed streaming, divided by that content's own
 * first-to-last nonempty delta window.
 *
 * Official usage and billing are never read, replaced, or altered here, and a
 * sample is never fabricated: a window that never spanned the minimum
 * observable interval (a buffered or collapsed stream) is skipped, not
 * extrapolated, and the whole-turn wall clock is never a denominator.
 */
import { getEncoding } from 'js-tiktoken';
import type { AgentEvent } from './index.ts';

/** Labels every sample produced by the unified approximate contract. */
export const TOKENIZER_TPS_SAMPLING_CONTRACT = 'tokenizer_v1';

/** Minimum observable generation span for a trustworthy speed sample. */
export const TOKENIZER_MINIMUM_WINDOW_MS = 100;

/** The legacy client-reported turn contract, attached only to trusted usage. */
export const TOKEN_SCOPE_AGENT_TURN = 'agent_turn';
export const DURATION_SCOPE_AGENT_TURN = 'agent_turn';
export const TPS_CONTRACT_AGENT_TURN_V1 = 'agent_turn_v1';

/** The full additive field set the agent_turn_v1 contract owns. */
const TRUSTED_CONTRACT_FIELDS = ['token_scope', 'duration_scope', 'tps_contract'] as const;

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
}

/** Fixed tokenizer, created lazily on first use and shared process-wide. */
let tokenizer: ReturnType<typeof getEncoding> | undefined;

/**
 * Counts text as ordinary text with the fixed cl100k_base vocabulary, so a
 * special-token lookalike in model output can never throw. Returns undefined
 * when the tokenizer cannot be constructed, which makes the caller skip the
 * sample instead of reporting a partial count.
 */
export function countTPSTokens(text: string): number | undefined {
    if (text === '') return 0;
    try {
        tokenizer ??= getEncoding('cl100k_base');
    } catch {
        return undefined;
    }
    if (!tokenizer) return undefined;
    return tokenizer.encode(text, [], []).length;
}

/**
 * Accumulates one generation's streamed content, one block per content
 * channel, with a monotonic arrival boundary. Each block is concatenated
 * before encoding so the count never depends on how a client splits its
 * deltas; the window is the first to last nonempty delta, so completion
 * latency is never part of the measurement.
 */
export class TokenizerGeneration {
    private readonly blocks = new Map<string, string>();
    private firstMS = 0;
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
        if (this.blocks.size === 0) this.firstMS = at;
        this.blocks.set(key, (this.blocks.get(key) ?? '') + text);
        this.lastMS = at;
    }

    /** True once any observed delta has poisoned the window. */
    get poisoned(): boolean {
        return this.invalid;
    }

    /**
     * Closes the window: total approximate tokens over every concatenated
     * block, plus its first and last nonempty delta boundaries. Undefined when
     * the window is unmeasurable — poisoned, never started, shorter than the
     * minimum observable span, uncountable, or zero tokens.
     */
    measure(): { tokens: number; first_token_at_ms: number; completed_at_ms: number } | undefined {
        if (this.invalid || this.blocks.size === 0) return undefined;
        if (this.lastMS - this.firstMS < TOKENIZER_MINIMUM_WINDOW_MS) return undefined;
        let tokens = 0;
        for (const text of this.blocks.values()) {
            const count = countTPSTokens(text);
            if (count === undefined) return undefined;
            tokens += count;
        }
        if (!Number.isSafeInteger(tokens) || tokens <= 0) return undefined;
        return { tokens, first_token_at_ms: this.firstMS, completed_at_ms: this.lastMS };
    }
}

/**
 * Attaches the legacy agent_turn_v1 accounting scope to a usage record. The
 * caller must already have established that the duration is a genuine
 * client-reported turn interval and the token counts are complete.
 */
export function applyTrustedAgentTurnContract(data: Record<string, unknown>): void {
    data.token_scope = TOKEN_SCOPE_AGENT_TURN;
    data.duration_scope = DURATION_SCOPE_AGENT_TURN;
    data.tps_contract = TPS_CONTRACT_AGENT_TURN_V1;
}

/** Removes every trusted contract field, preserving the raw token and duration metadata. */
export function clearTrustedAgentTurnContract(data: Record<string, unknown>): void {
    for (const key of TRUSTED_CONTRACT_FIELDS) delete data[key];
}

/**
 * Removes the trusted contract from an already-built turn_usage event so
 * untrusted usage keeps its metadata without any statistical claim.
 */
export function removeTrustFields(event: AgentEvent): void {
    if (event.type !== 'output' || event.record.type !== 'turn_usage') return;
    clearTrustedAgentTurnContract(event.record);
}

/** True when both native token counts are present, integral, and nonnegative. */
export function completeUsageTokens(usage: Record<string, unknown>): { input: number; output: number } | undefined {
    const input = nonnegativeInt(usage.input_tokens);
    const output = nonnegativeInt(usage.output_tokens);
    if (input === undefined || output === undefined) return undefined;
    return { input, output };
}

/** A whole nonnegative JSON number; rejects negative, fractional, and non-numeric values. */
export function nonnegativeInt(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    if (value < 0 || !Number.isInteger(value) || !Number.isSafeInteger(value)) return undefined;
    return value;
}

/** A whole positive JSON number; rejects zero, negative, fractional, and non-numeric values. */
export function positiveInt(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    if (value <= 0 || !Number.isInteger(value) || !Number.isSafeInteger(value)) return undefined;
    return value;
}

/** Overflow-safe addition so a hostile transcript can never wrap a token sum. */
export function addUsageTokens(a: number, b: number): number | undefined {
    const sum = a + b;
    if (!Number.isSafeInteger(sum) || sum < 0) return undefined;
    return sum;
}

/** A positive safe-integer millisecond boundary, or undefined when unusable. */
export function timestampValue(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    if (!Number.isInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) return undefined;
    return value;
}

/** Reads one non-empty string field, mirroring the driver's getString. */
function stringField(record: Record<string, unknown> | undefined, key: string): string {
    const value = record?.[key];
    return typeof value === 'string' && value !== '' ? value : '';
}

/** Reads one nested object field, when it is a plain object rather than an array. */
function recordField(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
    const value = record?.[key];
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** True when any normalized failure carrier is present and non-null. */
export function hasNormalizedFailureField(record: Record<string, unknown>): boolean {
    for (const key of ['error', 'failure', 'failure_class', 'recovery_at', 'retry_after_seconds']) {
        const value = record[key];
        if (value !== undefined && value !== null) return true;
    }
    return false;
}

/**
 * responseTPSSampler consumes only the partial stream protocol of the
 * Claude/CodeBuddy families. It observes `stream_event` envelopes and full
 * records alike, skips subagent children, invalidates the active response on
 * any retry/error/overlap, and only ever hands samples to a turn_usage that
 * follows a successful terminal `result`.
 */
export class ResponseTpsSampler {
    private readonly now: () => number;
    private anchorMS = 0;
    private anchored = false;
    private active: { id: string; model: string; gen: TokenizerGeneration; overlapped: boolean } | undefined;
    private readonly seen = new Set<string>();
    private samples: ResponseTpsSample[] = [];
    private terminalSeen = false;
    private terminalOK = false;

    constructor(now: () => number = () => Date.now()) {
        this.now = now;
    }

    /** Monotonic stamp anchored at the first observation, so a clock step can never rewind a window. */
    private timestamp(): number {
        const now = this.now();
        if (!this.anchored) {
            this.anchorMS = Math.floor(now);
            this.anchored = true;
            return this.anchorMS;
        }
        return this.anchorMS + Math.max(0, Math.floor(now - this.anchorMS));
    }

    private invalidateActive(): void {
        if (this.active && this.active.id !== '') this.seen.add(this.active.id);
        this.active = undefined;
    }

    /** Consumes one raw record. Every record is fed here before normalization. */
    observe(record: Record<string, unknown>): void {
        const parent = record.parent_tool_use_id;
        if (typeof parent === 'string' && parent.trim() !== '') return;
        const event = recordField(record, 'event');
        const rawType = stringField(record, 'type');
        const type = rawType === 'stream_event' || rawType === '' ? stringField(event, 'type') : rawType;

        if (type === 'result') {
            this.terminalOK = !this.terminalSeen && !hasNormalizedFailureField(record) && record.is_error !== true;
            this.terminalSeen = true;
            this.invalidateActive();
            return;
        }
        if (type === 'system' && record.subtype === 'api_retry') {
            this.invalidateActive();
            return;
        }
        switch (type) {
            case 'message_start':
                this.observeMessageStart(record, event);
                break;
            case 'content_block_delta':
                this.observeContentDelta(record, event);
                break;
            case 'message_stop':
                this.observeMessageStop(record, event);
                break;
            case 'error':
            case 'message_error':
            case 'failed':
            case 'cancelled':
            case 'canceled':
            case 'retry':
            case 'retried':
                this.invalidateActive();
                break;
        }
    }

    private observeMessageStart(record: Record<string, unknown>, event: Record<string, unknown> | undefined): void {
        const overlapped = this.active !== undefined;
        if (this.active) this.invalidateActive();
        const message = recordField(event, 'message') ?? recordField(record, 'message');
        const id = stringField(message, 'id').trim();
        const model = stringField(message, 'model').trim();
        if (id === '' || model === '' || this.seen.has(id)) return;
        this.active = { id, model, gen: new TokenizerGeneration(), overlapped };
    }

    private responseMatches(record: Record<string, unknown>, event: Record<string, unknown> | undefined): boolean {
        if (!this.active) return false;
        for (const key of ['response_id', 'message_id']) {
            const id = stringField(record, key).trim() || stringField(event, key).trim();
            if (id !== '' && id !== this.active.id) {
                this.invalidateActive();
                return false;
            }
        }
        return true;
    }

    /** Names one streamed content block: delta type plus its index, so tool arguments never merge. */
    private blockKey(record: Record<string, unknown>, event: Record<string, unknown> | undefined, deltaType: string): string {
        for (const source of [event, record]) {
            const index = source?.index;
            if (typeof index === 'number' && Number.isFinite(index)) return `${deltaType}/${Math.trunc(index)}`;
        }
        return deltaType;
    }

    private observeContentDelta(record: Record<string, unknown>, event: Record<string, unknown> | undefined): void {
        if (!this.responseMatches(record, event) || !this.active || this.active.overlapped) return;
        const delta = recordField(event, 'delta') ?? recordField(record, 'delta');
        const deltaType = stringField(delta, 'type');
        let value = '';
        switch (deltaType) {
            case 'text_delta':
                value = stringField(delta, 'text');
                break;
            case 'thinking_delta':
                value = stringField(delta, 'thinking');
                break;
            case 'input_json_delta':
                value = stringField(delta, 'partial_json');
                break;
        }
        if (value === '') return;
        this.active.gen.observe(this.blockKey(record, event, deltaType), value, this.timestamp());
    }

    private observeMessageStop(record: Record<string, unknown>, event: Record<string, unknown> | undefined): void {
        if (!this.responseMatches(record, event) || !this.active) return;
        const active = this.active;
        this.active = undefined;
        this.seen.add(active.id);
        if (active.overlapped) return;
        const measured = active.gen.measure();
        if (!measured) return;
        this.samples.push({
            response_id: active.id,
            model: active.model,
            output_tokens: measured.tokens,
            first_token_at_ms: measured.first_token_at_ms,
            completed_at_ms: measured.completed_at_ms,
        });
    }

    /**
     * Writes the accumulated samples onto a turn_usage record. Callers invoke
     * this only after a successful terminal result; a sampler that never
     * completed a response leaves the record untouched rather than empty.
     */
    takeSamples(data: Record<string, unknown>): boolean {
        if (this.samples.length === 0) return false;
        const attached = attachTpsSamples(data, this.samples);
        this.samples = [];
        return attached;
    }

    /** True once the sampler is allowed to attach samples to a terminal usage. */
    get attachable(): boolean {
        return this.terminalSeen && this.terminalOK;
    }
}

/**
 * Attaches tokenizer_v1 samples to a turn_usage record. Every sample is emitted
 * unchanged on the existing schema; the canonical official usage fields are
 * never modified.
 */
export function attachTpsSamples(
    data: Record<string, unknown>,
    samples: readonly (ResponseTpsSample | AggregatedResponseTpsSample)[],
): boolean {
    if (samples.length === 0) return false;
    data.tps_sampling_contract = TOKENIZER_TPS_SAMPLING_CONTRACT;
    data.tps_samples = samples.map((sample) => ({ ...sample }));
    return true;
}

/** Reads a nested text payload: top-level `text`, or the text blocks of `message.content`. */
function cursorRecordText(record: Record<string, unknown>): string {
    const direct = stringField(record, 'text');
    if (direct !== '') return direct;
    const message = recordField(record, 'message');
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    let text = '';
    for (const block of content) {
        if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
        const item = block as Record<string, unknown>;
        if (item.type === 'text' && typeof item.text === 'string') text += item.text;
    }
    return text;
}

/** True when a field is present and carries a non-blank string or a non-null value. */
function hasCursorField(record: Record<string, unknown>, key: string): boolean {
    const value = record[key];
    if (value === undefined) return false;
    if (typeof value === 'string') return value.trim() !== '';
    return value !== null;
}

/** Reads the native Cursor conversation id from either shape the CLI emits. */
function cursorSessionId(record: Record<string, unknown>): string {
    for (const key of ['session_id', 'sessionId', 'native_session_id', 'conversation_id']) {
        const value = stringField(record, key).trim();
        if (value !== '') return value;
    }
    return '';
}

/** True when args (possibly nested or a JSON string) declare a background/subagent run. */
function cursorArgsBackground(raw: unknown): boolean {
    if (Array.isArray(raw)) return raw.some((item) => cursorArgsBackground(item));
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed === '' || trimmed[0] !== '{') return false;
        try {
            return cursorArgsBackground(JSON.parse(trimmed) as unknown);
        } catch {
            return false;
        }
    }
    if (!raw || typeof raw !== 'object') return false;
    const value = raw as Record<string, unknown>;
    if (value.isBackground === true) return true;
    return Object.values(value).some((nested) => cursorArgsBackground(nested));
}

/**
 * Rejects tool records whose aggregate token coverage is unclear: a
 * subagent/background task tool, or args declaring isBackground.
 */
function cursorToolExcluded(record: Record<string, unknown>): boolean {
    for (const key of ['taskToolCall', 'subagentToolCall']) {
        const raw = record[key];
        if (raw === undefined || raw === null) continue;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return true;
        if (cursorArgsBackground((raw as Record<string, unknown>).args)) return true;
    }
    if (cursorArgsBackground(record.args)) return true;
    const toolCall = recordField(record, 'tool_call');
    if (!toolCall) return false;
    for (const [key, value] of Object.entries(toolCall)) {
        const lowered = key.toLowerCase();
        if (lowered.includes('task') || lowered.includes('subagent')) return true;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (cursorArgsBackground((value as Record<string, unknown>).args)) return true;
        }
    }
    return false;
}

/** Classifies the single native Cursor terminal record. */
function cursorTerminalOutcome(type: string, record: Record<string, unknown>): { status: string; terminal: boolean } {
    if (type === 'error' || type === 'failed') return { status: 'failed', terminal: true };
    if (type !== 'result' && type !== 'run_finished') return { status: '', terminal: false };
    if (record.is_error === true) return { status: 'failed', terminal: true };
    const subtype = stringField(record, 'subtype').toLowerCase().trim();
    switch (subtype) {
        case 'success':
        case 'done':
        case 'ok':
        case 'complete':
        case 'completed':
            return { status: 'done', terminal: true };
        case 'error':
        case 'failed':
        case 'failure':
        case 'cancelled':
        case 'canceled':
            return { status: 'failed', terminal: true };
    }
    const status = stringField(record, 'status').toLowerCase().trim();
    switch (status) {
        case 'done':
        case 'success':
        case 'complete':
        case 'completed':
            return { status: 'done', terminal: true };
        case 'error':
        case 'failed':
        case 'failure':
        case 'cancelled':
        case 'canceled':
            return { status: 'failed', terminal: true };
    }
    // A terminal record with no recognized success/failure signal is malformed.
    return { status: '', terminal: false };
}

/**
 * cursorTPSampler is the strict whole-turn state machine for one Cursor
 * invocation. Any structural surprise (retry, reconnect, error, interaction
 * query, malformed timing, session change, unknown tool completion, truncated
 * or duplicate terminal, unknown record type) poisons the stream. An
 * unobservable generation window is merely skipped, so it never poisons the
 * other complete valid windows.
 */
export class CursorTpsSampler {
    private poisoned = false;
    private started = false;
    private session = '';
    private initSeen = 0;
    private lastTimestampMS = 0;
    private terminalRequestID = '';
    private terminalSeen = false;
    private terminalOK = false;
    private generation = new TokenizerGeneration();
    private inGeneration = false;
    private lastDeltaMS = 0;
    private readonly pendingTools = new Map<string, string>();
    private readonly callIDs = new Set<string>();
    private partialText = '';
    private windows: GenerationWindow[] = [];

    /**
     * Consumes one raw Cursor stream-json record. Every record is fed here
     * before normalization so a malformed or unsupported record still poisons
     * the sample.
     */
    observe(record: Record<string, unknown>): void {
        if (this.poisoned) return;
        const type = stringField(record, 'type').toLowerCase().trim();
        // A record after the terminal result means the stream continued past
        // its own boundary: duplicate or truncated.
        if (this.terminalSeen) {
            this.poisoned = true;
            return;
        }
        const session = cursorSessionId(record);
        if (this.session !== '' && session !== '' && session !== this.session) {
            this.poisoned = true;
            return;
        }
        this.started = true;
        if (!this.observeTimestamp(record)) return;

        switch (type) {
            case 'system':
                this.observeSystem(record);
                break;
            case 'connection':
            case 'retry':
            case 'retried':
            case 'reconnect':
            case 'reconnected':
            case 'interaction_query':
                this.poisoned = true;
                break;
            case 'thinking':
                this.observeThinking(record);
                break;
            case 'assistant':
                this.observeAssistant(record);
                break;
            case 'tool_call':
                this.observeToolCall(record);
                break;
            case 'result':
                this.observeResult(record);
                break;
            case 'user':
                if (this.inGeneration || this.windows.length !== 0 || this.pendingTools.size !== 0) this.poisoned = true;
                break;
            default:
                this.poisoned = true;
        }
    }

    /** Every present timestamp_ms must be a positive safe integer and globally nondecreasing. */
    private observeTimestamp(record: Record<string, unknown>): boolean {
        if (!('timestamp_ms' in record)) return true;
        const at = timestampValue(record.timestamp_ms);
        if (at === undefined) {
            this.poisoned = true;
            return false;
        }
        if (this.started && at < this.lastTimestampMS) {
            this.poisoned = true;
            return false;
        }
        this.lastTimestampMS = at;
        return true;
    }

    private eventTimestamp(record: Record<string, unknown>): number | undefined {
        if (!('timestamp_ms' in record)) return undefined;
        return timestampValue(record.timestamp_ms);
    }

    /** Init must be unique and carry a nonempty native session and model. */
    private observeSystem(record: Record<string, unknown>): void {
        if (stringField(record, 'subtype').toLowerCase().trim() !== 'init') {
            this.poisoned = true;
            return;
        }
        this.initSeen += 1;
        if (this.initSeen > 1) {
            this.poisoned = true;
            return;
        }
        const session = cursorSessionId(record);
        if (session === '') {
            this.poisoned = true;
            return;
        }
        this.session = session;
        if (stringField(record, 'model').trim() === '') this.poisoned = true;
    }

    private observeThinking(record: Record<string, unknown>): void {
        const subtype = stringField(record, 'subtype');
        if (subtype.toLowerCase().trim() === 'completed') return;
        if (subtype !== 'delta') {
            this.poisoned = true;
            return;
        }
        const text = cursorRecordText(record);
        if (text === '') return;
        if (this.pendingTools.size !== 0) return;
        const at = this.eventTimestamp(record);
        if (at === undefined) {
            this.poisoned = true;
            return;
        }
        this.markGenerationActivity('thinking', text, at);
    }

    /**
     * A record carrying a model_call_id, or repeating the accumulated partial
     * text, is the CLI's summary flush: it never opens or extends a window.
     */
    private observeAssistant(record: Record<string, unknown>): void {
        const text = cursorRecordText(record);
        if (text === '') return;
        if (hasCursorField(record, 'model_call_id')) {
            if (this.partialText === '' || text !== this.partialText) this.poisoned = true;
            this.partialText = '';
            return;
        }
        const at = this.eventTimestamp(record);
        if (at === undefined) {
            if (this.partialText === '' || text !== this.partialText) {
                this.poisoned = true;
                return;
            }
            this.partialText = '';
            return;
        }
        this.partialText += text;
        if (this.pendingTools.size !== 0) return;
        this.markGenerationActivity('text', text, at);
    }

    private observeToolCall(record: Record<string, unknown>): void {
        switch (stringField(record, 'subtype').toLowerCase().trim()) {
            case 'started':
                this.observeToolStarted(record);
                break;
            case 'completed':
                this.observeToolCompleted(record);
                break;
            default:
                this.poisoned = true;
        }
    }

    private observeToolStarted(record: Record<string, unknown>): void {
        const callID = stringField(record, 'call_id').trim();
        if (callID === '') {
            this.poisoned = true;
            return;
        }
        const modelCallID = stringField(record, 'model_call_id').trim();
        if (modelCallID === '' || cursorToolExcluded(record) || this.callIDs.has(callID)) {
            this.poisoned = true;
            return;
        }
        const at = this.eventTimestamp(record);
        if (at === undefined) {
            this.poisoned = true;
            return;
        }
        // A tool start can never precede the last delta of the generation it
        // closes; a tool-only response simply contributes no window.
        if (this.inGeneration && at < this.lastDeltaMS) {
            this.poisoned = true;
            return;
        }
        this.closeGeneration();
        this.callIDs.add(callID);
        this.pendingTools.set(callID, modelCallID);
    }

    private observeToolCompleted(record: Record<string, unknown>): void {
        const callID = stringField(record, 'call_id').trim();
        if (callID === '') {
            this.poisoned = true;
            return;
        }
        const modelCallID = this.pendingTools.get(callID);
        if (modelCallID === undefined) {
            this.poisoned = true;
            return;
        }
        const completedModelCallID = stringField(record, 'model_call_id').trim();
        if (completedModelCallID === '' || completedModelCallID !== modelCallID || this.eventTimestamp(record) === undefined) {
            this.poisoned = true;
            return;
        }
        this.pendingTools.delete(callID);
    }

    /** The terminal must be the last record and carry a complete, consistent, successful turn. */
    private observeResult(record: Record<string, unknown>): void {
        const outcome = cursorTerminalOutcome('result', record);
        if (!outcome.terminal || outcome.status !== 'done') {
            this.poisoned = true;
            return;
        }
        const requestID = stringField(record, 'request_id').trim();
        if (requestID === '' || this.pendingTools.size !== 0) {
            this.poisoned = true;
            return;
        }
        const session = cursorSessionId(record);
        if (session !== '' && this.session !== '' && session !== this.session) {
            this.poisoned = true;
            return;
        }
        this.closeGeneration();
        this.terminalRequestID = requestID;
        this.terminalOK = true;
        this.terminalSeen = true;
    }

    private markGenerationActivity(channel: string, text: string, at: number): void {
        if (this.inGeneration && at < this.lastDeltaMS) {
            this.poisoned = true;
            return;
        }
        this.inGeneration = true;
        this.generation.observe(channel, text, at);
        this.lastDeltaMS = at;
    }

    /** Ends the active window at its own last nonempty delta; an unobservable window is skipped. */
    private closeGeneration(): void {
        if (!this.inGeneration) return;
        this.inGeneration = false;
        const generation = this.generation;
        this.generation = new TokenizerGeneration();
        const measured = generation.measure();
        if (!measured) return;
        this.windows.push(measured);
    }

    /**
     * Returns the single aggregate sample, or undefined when the stream did not
     * pass. The sample tokens are the aggregate of the per-window approximate
     * counts, never the terminal official usage.
     */
    finalize(usage: Record<string, unknown> | undefined, model: string): AggregatedResponseTpsSample | undefined {
        if (this.poisoned || !this.terminalOK || !this.terminalSeen || !this.started) return undefined;
        if (this.initSeen !== 1 || this.session === '') return undefined;
        if (this.inGeneration || this.windows.length === 0) return undefined;
        // The terminal official usage stays a validity gate; its counts are
        // never attributed to the speed sample.
        if (nonnegativeInt(usage?.output_tokens) === undefined) return undefined;
        let tokens = 0;
        for (const window of this.windows) {
            const sum = addUsageTokens(tokens, window.tokens);
            if (sum === undefined) return undefined;
            tokens = sum;
        }
        if (tokens <= 0) return undefined;
        return {
            response_id: `cursor-turn:${this.terminalRequestID}`,
            model,
            output_tokens: tokens,
            generation_windows: this.windows.map((window) => ({ ...window })),
        };
    }
}

/**
 * cursorAssistantTextDeduper is the shared lookahead helper that removes the
 * aggregate assistant summary flushes the Cursor CLI emits alongside real
 * deltas. It rebuilds the turn's real text from assistant/record text without
 * duplicating a summary.
 */
export class CursorAssistantTextDeduper {
    private accumulated = '';
    private pending = '';

    /** Consumes one record and returns the real turn text it contributed. */
    observe(record: Record<string, unknown> | undefined): string {
        if (!record) return '';
        const type = stringField(record, 'type').toLowerCase().trim();
        const text = cursorRecordText(record);
        // A retry/reconnect/interaction query repeating the whole accumulation
        // is the CLI's summary of that text, not new content.
        if (['retry', 'retried', 'reconnect', 'reconnected', 'interaction_query'].includes(type)
            && this.pending !== '' && this.accumulated !== '' && this.pending === this.accumulated) {
            this.pending = '';
            this.accumulated = '';
            return '';
        }
        let out = this.flushPending();
        if (type !== 'assistant' || text === '') return out;
        const hasTimestamp = 'timestamp_ms' in record;
        if (hasCursorField(record, 'model_call_id') || !hasTimestamp) {
            if (this.accumulated !== '' && text === this.accumulated) {
                this.accumulated = '';
                return out;
            }
            this.accumulated = '';
            return out + text;
        }
        this.pending = text;
        return out;
    }

    private flushPending(): string {
        const text = this.pending;
        this.pending = '';
        this.accumulated += text;
        return text;
    }

    /** Flushes any still-held text, for truncated logs. */
    finish(): string {
        return this.flushPending();
    }
}
