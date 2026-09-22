import type { AgentEvent, StreamChunk } from '@wrenyard/agent-client';
import {
    finishedEvent, fnv1a64Hex, jsonStringValue, messageEvent, readNativeRecords, recordOf, sessionIdOf, stringOf, toolCallRecord, toolResultRecord,
    turnUsageRecord,
} from '@wrenyard/agent-client/native';
import { addUsageTokens, nonnegativeInt } from '@wrenyard/agent-client/statistics';

/**
 * Decode the OpenCode native stream-json transcript.
 *
 * One `step_finish` record is emitted per model step, so per-step usage is
 * summed across the invocation and exactly one canonical turn_usage is
 * emitted. The tool lifecycle lives in a nested `part.state` object in current
 * OpenCode and in flattened fields in earlier shapes; both normalize
 * identically, with a stable call_id from the native part id or a
 * deterministic content-derived fallback.
 */
export async function* decodeOpenCode(events: AsyncIterable<StreamChunk>): AsyncGenerator<AgentEvent> {
    let sessionId: string | undefined;
    let output = '';
    let ended = false;
    const usage = {
        input: 0, output: 0, reasoning: 0, total: 0,
        seen: false, invalid: false,
    };
    const flushUsage = (): AgentEvent | undefined => {
        if (!usage.seen)
            return undefined;
        const data: Record<string, unknown> = {
            input_tokens: usage.input,
            output_tokens: usage.output,
            // A per-step record has no measured full-turn interval, so the
            // canonical emission carries the truthful non-positive placeholder.
            duration_ms: 0,
        };
        if (usage.reasoning > 0)
            data.reasoning_output_tokens = usage.reasoning;
        if (usage.total > 0)
            data.total_tokens = usage.total;
        return { type: 'output', record: turnUsageRecord(data) };
    };
    for await (const item of readNativeRecords(events)) {
        if (item.kind === 'event') {
            if (item.event.type === 'exit') {
                const terminal = flushUsage();
                if (terminal)
                    yield terminal;
                yield finishedEvent('opencode', sessionId, output, !ended || item.event.exitCode !== 0 && item.event.exitCode !== null);
            }
            yield item.event;
            continue;
        }
        const record = item.record;
        const id = sessionIdOf(record);
        if (id)
            sessionId = id;
        const type = stringOf(record, 'type');
        if (type === 'text') {
            const text = openCodeEventText(record);
            if (text) {
                output = text;
                yield messageEvent(text);
            }
            continue;
        }
        if (type === 'step_finish') {
            observeStepUsage(usage, record);
            continue;
        }
        if (type === 'tool_use') {
            for (const event of toolUseEvents(record))
                yield event;
            continue;
        }
        if (type === 'error') {
            ended = true;
            yield finishedEvent('opencode', sessionId, output, true);
        }
    }
}

/** Sums one native step's tokens into the invocation aggregate. */
function observeStepUsage(usage: { input: number; output: number; reasoning: number; total: number; seen: boolean; invalid: boolean }, record: Record<string, unknown>): void {
    const part = recordOf(record, 'part');
    const tokens = part ? recordOf(part, 'tokens') : undefined;
    if (!tokens)
        return;
    usage.seen = true;
    const input = nonnegativeInt(tokens.input);
    const output = nonnegativeInt(tokens.output);
    if (input === undefined || output === undefined) {
        usage.invalid = true;
        return;
    }
    const sumInput = addUsageTokens(usage.input, input);
    const sumOutput = addUsageTokens(usage.output, output);
    if (sumInput === undefined || sumOutput === undefined) {
        usage.invalid = true;
        return;
    }
    usage.input = sumInput;
    usage.output = sumOutput;
    const reasoning = nonnegativeInt(tokens.reasoning);
    if (reasoning !== undefined) {
        const sum = addUsageTokens(usage.reasoning, reasoning);
        if (sum !== undefined)
            usage.reasoning = sum;
    }
    const total = nonnegativeInt(tokens.total);
    if (total !== undefined) {
        const sum = addUsageTokens(usage.total, total);
        if (sum !== undefined)
            usage.total = sum;
    }
}

/** Normalizes a tool_use record into a paired call/result when the part is terminal. */
function* toolUseEvents(record: Record<string, unknown>): Generator<AgentEvent> {
    const part = recordOf(record, 'part');
    if (!part)
        return;
    const name = partToolName(part);
    if (!name.trim())
        return;
    const state = recordOf(part, 'state');
    const input = partInput(part, state);
    const inputSummary = jsonStringValue(input);
    const callId = toolCallId(record, part, name, inputSummary);
    if (!callId)
        return;
    const sessionId = stringOf(record, 'sessionID') || stringOf(record, 'session_id') || stringOf(record, 'sessionId');
    yield { type: 'output', record: toolCallRecord(name, callId, inputSummary, sessionId || undefined) };
    const outcome = partTerminal(part, state);
    if (!outcome)
        return;
    yield { type: 'output', record: toolResultRecord(callId, outcome.status, outcome.output, sessionId || undefined) };
}

/** Reads the tool name across the nested and flattened part shapes. */
function partToolName(part: Record<string, unknown>): string {
    return stringOf(part, 'tool') || stringOf(part, 'name') || stringOf(part, 'toolName') || stringOf(part, 'tool_name');
}

function partInput(part: Record<string, unknown>, state: Record<string, unknown> | undefined): unknown {
    if (state && state.input !== undefined)
        return state.input;
    if (part.input !== undefined)
        return part.input;
    return part.args;
}

/** The stable call id from the native part id, or a deterministic fallback so pairs agree. */
function toolCallId(record: Record<string, unknown>, part: Record<string, unknown>, name: string, input: string): string {
    for (const container of [part, record]) {
        for (const key of ['id', 'toolCallId', 'tool_call_id']) {
            const id = stringOf(container, key);
            if (id)
                return id;
        }
    }
    return `oc_${fnv1a64Hex(name, input)}`;
}

/** Determines whether the part lifecycle is terminal, and its normalized status and output. */
function partTerminal(part: Record<string, unknown>, state: Record<string, unknown> | undefined): { status: 'ok' | 'error'; output: string } | undefined {
    let status = '';
    if (state)
        status = stringOf(state, 'status');
    if (!status.trim() && typeof part.state === 'string')
        status = part.state;
    if (!status.trim())
        status = stringOf(part, 'status');
    const lowered = status.toLowerCase().trim();
    if (['completed', 'complete', 'done', 'success', 'succeeded', 'output-available', 'output_available'].includes(lowered))
        return { status: 'ok', output: partOutput(part, state) };
    if (['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(lowered))
        return { status: 'error', output: partOutput(part, state) };
    return undefined;
}

function partOutput(part: Record<string, unknown>, state: Record<string, unknown> | undefined): string {
    for (const source of [state, part]) {
        if (!source)
            continue;
        for (const key of ['output', 'result', 'error'] as const) {
            if (source[key] !== undefined && source[key] !== null) {
                const text = jsonStringValue(source[key]);
                if (text)
                    return text;
            }
        }
    }
    return '';
}

/** Reads one `step_finish`-style text part. */
function openCodeEventText(record: Record<string, unknown>): string {
    const part = recordOf(record, 'part');
    return part ? stringOf(part, 'text') : '';
}
