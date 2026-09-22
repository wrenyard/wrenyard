import type { AgentEvent, StreamChunk } from '@wrenyard/agent-client';
import { finishedEvent, jsonStringValue, messageEvent, readNativeRecords, recordOf, sessionIdOf, stringOf, toolCallRecord, toolResultRecord } from '@wrenyard/agent-client/native';
import { TOKENIZER_MINIMUM_WINDOW_MS, TOKENIZER_TPS_SAMPLING_CONTRACT, addUsageTokens, applyTrustedAgentTurnContract, countTPSTokens, nonnegativeInt, positiveInt } from '@wrenyard/agent-client/statistics';

/** JSONL protocol name emitted by the embedded DSH bridge plugin. */
const DSH_BRIDGE_PROTOCOL = 'wrenyard.dsh.stream.v1';

/**
 * Decode the native DSH transcript stream.
 *
 * The bridge plugin emits one JSON object per line carrying
 * `protocol: 'wrenyard.dsh.stream.v1'`, the native session id, and a nested
 * `event` field naming the record kind. A headless invocation can additionally
 * print a bare final assistant line on stdout, which arrives as no record at
 * all and is ignored here — the bridge's `assistant/message` is authoritative.
 *
 * A `turn/end` record is the real terminal signal: `status` decides success, and
 * a failed or interrupted turn is never re-declared successful merely because
 * the process exited 0.
 */
export async function* decodeDsh(events: AsyncIterable<StreamChunk>): AsyncGenerator<AgentEvent> {
    let sessionId: string | undefined;
    let output = '';
    let failed = false;
    let ended = false;
    for await (const item of readNativeRecords(events)) {
        if (item.kind === 'event') {
            if (item.event.type === 'error') failed = true;
            if (item.event.type === 'exit')
                yield finishedEvent('dsh', sessionId, output, failed || !ended || item.event.exitCode !== 0);
            yield item.event;
            continue;
        }
        const record = item.record;
        if (record.protocol !== DSH_BRIDGE_PROTOCOL)
            continue;
        const id = sessionIdOf(record);
        if (id)
            sessionId = id;
        const kind = stringOf(record, 'event') || stringOf(record, 'type');
        if (kind === 'tool/call') {
            const callId = dshCallId(record);
            if (callId) {
                yield { type: 'output', record: toolCallRecord(
                    stringOf(record, 'name') || stringOf(record, 'tool') || 'tool_call',
                    callId,
                    jsonStringValue(record.input),
                    sessionId,
                ) };
            }
            continue;
        }
        if (kind === 'tool/result') {
            const callId = dshCallId(record);
            if (callId) {
                yield { type: 'output', record: toolResultRecord(
                    callId,
                    dshToolStatus(record),
                    jsonStringValue(record.output) || jsonStringValue(record.result) || jsonStringValue(record.error),
                    sessionId,
                ) };
            }
            continue;
        }
        if (kind === 'assistant/message') {
            const text = stringOf(record, 'text');
            if (text) {
                output = text;
                yield messageEvent(text);
            }
            continue;
        }
        // `assistant/chunk` deltas are intentionally not surfaced as text: the
        // bridge already emits the authoritative full message, so replaying
        // deltas would double the product output.
        if (kind === 'turn/end') {
            ended = true;
            const status = stringOf(record, 'status');
            failed ||= status !== 'complete';
            const usage = usageOf(record, failed);
            if (usage)
                yield { type: 'output', record: usage };
        }
    }
}

/**
 * Maps the bridge's cumulative turn usage onto the product usage record.
 *
 * The bridge may report `tps_generation`, its own record of the generation
 * content it observed streaming. Those are converted into canonical
 * tokenizer_v1 samples with the shared fixed tokenizer, and a window the
 * bridge could not observe is skipped rather than extrapolated. The turn's
 * duration is not provider generation time, so it never becomes a speed
 * denominator.
 */
function usageOf(record: Record<string, unknown>, failed: boolean): Record<string, unknown> | undefined {
    const usage = recordOf(record, 'usage');
    if (!usage)
        return undefined;
    const input = nonnegativeInt(usage.input_tokens);
    const output = nonnegativeInt(usage.output_tokens);
    const cacheRead = nonnegativeInt(usage.cache_read_input_tokens);
    const cacheWrite = nonnegativeInt(usage.cache_creation_input_tokens);
    if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined)
        return undefined;
    const data: Record<string, unknown> = {
        type: 'turn_usage',
        ...(input === undefined ? {} : { input_tokens: input }),
        ...(output === undefined ? {} : { output_tokens: output }),
        ...(cacheRead === undefined ? {} : { cache_read_input_tokens: cacheRead }),
        ...(cacheWrite === undefined ? {} : { cache_creation_input_tokens: cacheWrite }),
    };
    const durationMS = dshDurationMS(record);
    data.duration_ms = durationMS ?? 0;
    if (!failed && durationMS !== undefined && input !== undefined && output !== undefined)
        applyTrustedAgentTurnContract(data);
    if (!failed) {
        const samples = dshGenerationSamples(record);
        if (samples) {
            data.tps_sampling_contract = TOKENIZER_TPS_SAMPLING_CONTRACT;
            data.tps_samples = samples;
        }
    }
    return data;
}

/**
 * Converts the bridge's transient tps_generation payload into canonical
 * tokenizer_v1 samples: the fixed tokenizer over only the observed generation
 * blocks, divided by that generation's own first-to-last delta window. A
 * malformed payload is rejected outright; a window the bridge could not
 * observe skips only its own sample.
 */
export function dshGenerationSamples(record: Record<string, unknown>): unknown[] | undefined {
    const raw = record.tps_generation;
    if (!Array.isArray(raw))
        return undefined;
    const samples: Record<string, unknown>[] = [];
    for (const value of raw) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return undefined;
        const generation = value as Record<string, unknown>;
        const responseId = stringOf(generation, 'response_id').trim();
        const model = stringOf(generation, 'model').trim();
        const blocks = recordOf(generation, 'blocks');
        if (!responseId || !model || !blocks)
            return undefined;
        const entries = Object.values(blocks);
        if (entries.length === 0)
            continue;
        const first = dshFiniteNumber(generation.first_delta_at_ms);
        const last = dshFiniteNumber(generation.last_delta_at_ms);
        if (first === undefined || last === undefined || last <= first || last - first < TOKENIZER_MINIMUM_WINDOW_MS)
            continue;
        let tokens = 0;
        let countable = true;
        for (const block of entries) {
            if (typeof block !== 'string') {
                countable = false;
                break;
            }
            const count = countTPSTokens(block);
            if (count === undefined) {
                countable = false;
                break;
            }
            const sum = addUsageTokens(tokens, count);
            if (sum === undefined) {
                countable = false;
                break;
            }
            tokens = sum;
        }
        if (!countable)
            return undefined;
        if (tokens <= 0)
            continue;
        samples.push({
            response_id: responseId,
            model,
            // Approximate cl100k count of observed generation content, never
            // billed usage. completed_at_ms is the last observed delta, so
            // completion latency stays excluded.
            output_tokens: tokens,
            first_token_at_ms: first,
            completed_at_ms: last,
        });
    }
    return samples.length > 0 ? samples : undefined;
}

/** The bridge's native duration, from the primary field or the legacy one. */
function dshDurationMS(record: Record<string, unknown>): number | undefined {
    return positiveInt(record.duration) ?? positiveInt(record.duration_ms);
}

/** The tool call id from the primary callId field or the legacy fallbacks. */
function dshCallId(record: Record<string, unknown>): string {
    for (const key of ['callId', 'id', 'call_id']) {
        const value = stringOf(record, key).trim();
        if (value)
            return value;
    }
    return '';
}

function dshToolStatus(record: Record<string, unknown>): 'ok' | 'error' {
    if (record.is_error === true)
        return 'error';
    const status = stringOf(record, 'status').toLowerCase().trim();
    if (['done', 'success', 'ok', 'completed'].includes(status))
        return 'ok';
    if (['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(status))
        return 'error';
    return 'ok';
}

/** A finite numeric boundary; NaN and infinities are not observable timings. */
function dshFiniteNumber(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return undefined;
    return value;
}
