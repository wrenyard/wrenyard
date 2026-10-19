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
 * summed across the invocation. Each token partition is tracked separately and
 * the canonical turn_usage carries only the partitions the native transcript
 * actually measured; an absent or invalid partition is never emitted as an
 * initialized zero or a partial sum. The tool lifecycle lives in a nested
 * `part.state` object in current
 * OpenCode and in flattened fields in earlier shapes; both normalize
 * identically, with a stable call_id from the native part id or a
 * deterministic content-derived fallback.
 */
export async function* decodeOpenCode(events: AsyncIterable<StreamChunk>): AsyncGenerator<AgentEvent> {
    let sessionId: string | undefined;
    let output = '';
    // Completion/error bookkeeping. A healthy invocation must end its last model
    // step with a `stop` reason and must not have emitted a native error. The two
    // flags are independent and latch only the observed failure, so a later exit
    // can never turn a failed run into a success.
    let sawError = false;
    let completedStep = false;
    const usage = {
        input: 0, output: 0, reasoning: 0, total: 0,
        seen: false, inputIncomplete: false, outputIncomplete: false,
    };
    const flushUsage = (): AgentEvent | undefined => {
        if (!usage.seen)
            return undefined;
        // Each required partition is emitted only when every observed step
        // reported it. A missing, invalid or overflowed partition is never
        // replaced by an initialized zero or by the partial sum accumulated so
        // far; a genuinely measured zero remains a measured value.
        const inputComplete = !usage.inputIncomplete;
        const outputComplete = !usage.outputIncomplete;
        if (!inputComplete && !outputComplete)
            return undefined;
        const data: Record<string, unknown> = {
            // A per-step record has no measured full-turn interval, so the
            // canonical emission carries the truthful non-positive placeholder.
            duration_ms: 0,
        };
        if (inputComplete)
            data.input_tokens = usage.input;
        if (outputComplete)
            data.output_tokens = usage.output;
        // Optional partitions are only truthful invocation totals when both
        // required partitions were measured.
        if (inputComplete && outputComplete) {
            if (usage.reasoning > 0)
                data.reasoning_output_tokens = usage.reasoning;
            if (usage.total > 0)
                data.total_tokens = usage.total;
        }
        return { type: 'output', record: turnUsageRecord(data) };
    };
    for await (const item of readNativeRecords(events)) {
        if (item.kind === 'event') {
            if (item.event.type === 'exit') {
                const terminal = flushUsage();
                if (terminal)
                    yield terminal;
                yield finishedEvent('opencode', sessionId, output, sawError || !completedStep || item.event.exitCode !== 0 || item.event.signal !== null);
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
        if (type === 'step_start') {
            completedStep = false;
            continue;
        }
        if (type === 'step_finish') {
            const part = recordOf(record, 'part');
            completedStep = part !== undefined && stringOf(part, 'reason') === 'stop';
            observeStepUsage(usage, record);
            continue;
        }
        if (type === 'tool_use') {
            for (const event of toolUseEvents(record))
                yield event;
            continue;
        }
        if (type === 'error') {
            sawError = true;
            const errorText = openCodeErrorText(record);
            if (errorText)
                yield { type: 'error', message: errorText };
            yield finishedEvent('opencode', sessionId, output, true);
        }
    }
}

/** Sums one native step's tokens into the invocation aggregate, per partition. */
function observeStepUsage(usage: { input: number; output: number; reasoning: number; total: number; seen: boolean; inputIncomplete: boolean; outputIncomplete: boolean }, record: Record<string, unknown>): void {
    // A step_finish that reports no tokens still proves neither partition was
    // measured for this invocation; skipping it would leave earlier partial
    // sums looking complete.
    usage.seen = true;
    const part = recordOf(record, 'part');
    const tokens = part ? recordOf(part, 'tokens') : undefined;
    if (!tokens) {
        usage.inputIncomplete = true;
        usage.outputIncomplete = true;
        return;
    }
    const input = nonnegativeInt(tokens.input);
    if (input === undefined) {
        usage.inputIncomplete = true;
    } else {
        const sum = addUsageTokens(usage.input, input);
        if (sum === undefined) usage.inputIncomplete = true;
        else usage.input = sum;
    }
    const output = nonnegativeInt(tokens.output);
    if (output === undefined) {
        usage.outputIncomplete = true;
    } else {
        const sum = addUsageTokens(usage.output, output);
        if (sum === undefined) usage.outputIncomplete = true;
        else usage.output = sum;
    }
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

/**
 * Retains the native error payload's status, error type and message so the
 * execution layer can classify the upstream rejection instead of seeing only a
 * generic failed finish. Current OpenCode nests the payload in `error.data`
 * and earlier shapes flatten it; a JSON `responseBody` carries the provider's
 * own error identity and message.
 */
function openCodeErrorText(record: Record<string, unknown>): string {
    const error = recordOf(record, 'error');
    const data = error ? recordOf(error, 'data') ?? error : undefined;
    const status = nonnegativeInt(data?.statusCode) ?? nonnegativeInt(data?.status) ?? nonnegativeInt(record.statusCode);
    const body = openCodeErrorBody(data, error, record);
    const errorType = stringOf(body, 'type') || stringOf(data, 'type') || stringOf(error, 'errorType') || stringOf(record, 'errorType');
    const message = stringOf(body, 'message') || stringOf(data, 'message') || stringOf(error, 'message') || stringOf(record, 'message');
    const identity = [status === undefined ? '' : `HTTP ${status}`, errorType].filter(Boolean).join(' ');
    if (!identity)
        return message;
    return message ? `${identity}: ${message}` : identity;
}

/** Parses a JSON `responseBody` from the native payload, when one is present. */
function openCodeErrorBody(...sources: (Record<string, unknown> | undefined)[]): Record<string, unknown> | undefined {
    for (const source of sources) {
        const body = stringOf(source, 'responseBody');
        if (!body)
            continue;
        try {
            const value: unknown = JSON.parse(body);
            if (!value || typeof value !== 'object' || Array.isArray(value))
                continue;
            const root = value as Record<string, unknown>;
            return recordOf(root, 'error') ?? root;
        }
        catch { /* a non-JSON body carries no structured identity */ }
    }
    return undefined;
}
