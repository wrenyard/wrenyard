import type { AgentEvent, StreamChunk } from '@wrenyard/agent-client';
import {
    finishedEvent,
    jsonStringValue,
    messageEvent,
    readNativeRecords,
    recordOf,
    sessionIdOf,
    stringOf,
    toolCallRecord,
    toolResultRecord,
    turnUsageRecord,
} from '@wrenyard/agent-client/native';
import { addUsageTokens, nonnegativeInt } from '@wrenyard/agent-client/statistics';

const SUCCESSFUL_STOP_REASONS = new Set(['stop']);
const FAILED_STOP_REASONS = new Set(['tooluse', 'length', 'error', 'aborted', 'deferred']);

function normalizeStopReason(value: string): string {
    return value.trim().toLowerCase().replace(/_/g, '');
}

/** Extract assistant text from Pi `message_end` content blocks. */
function assistantText(message: Record<string, unknown>): string {
    const content = message.content;
    if (!Array.isArray(content))
        return stringOf(message, 'text');
    const parts: string[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object' || Array.isArray(block))
            continue;
        const entry = block as Record<string, unknown>;
        if (stringOf(entry, 'type') === 'text') {
            const text = stringOf(entry, 'text');
            if (text)
                parts.push(text);
        }
    }
    return parts.join('');
}

function observeMessageUsage(
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
        seen: boolean;
        inputIncomplete: boolean;
        outputIncomplete: boolean;
    },
    raw: Record<string, unknown> | undefined,
): void {
    if (!raw)
        return;
    usage.seen = true;
    const input = nonnegativeInt(raw.input) ?? nonnegativeInt(raw.inputTokens);
    if (input === undefined)
        usage.inputIncomplete = true;
    else {
        const sum = addUsageTokens(usage.input, input);
        if (sum === undefined) usage.inputIncomplete = true;
        else usage.input = sum;
    }
    const output = nonnegativeInt(raw.output) ?? nonnegativeInt(raw.outputTokens);
    if (output === undefined)
        usage.outputIncomplete = true;
    else {
        const sum = addUsageTokens(usage.output, output);
        if (sum === undefined) usage.outputIncomplete = true;
        else usage.output = sum;
    }
    const cacheRead = nonnegativeInt(raw.cacheRead) ?? nonnegativeInt(raw.cache_read);
    if (cacheRead !== undefined) {
        const sum = addUsageTokens(usage.cacheRead, cacheRead);
        if (sum !== undefined)
            usage.cacheRead = sum;
    }
    const cacheWrite = nonnegativeInt(raw.cacheWrite) ?? nonnegativeInt(raw.cache_write);
    if (cacheWrite !== undefined) {
        const sum = addUsageTokens(usage.cacheWrite, cacheWrite);
        if (sum !== undefined)
            usage.cacheWrite = sum;
    }
    const total = nonnegativeInt(raw.totalTokens) ?? nonnegativeInt(raw.total);
    if (total !== undefined) {
        const sum = addUsageTokens(usage.total, total);
        if (sum !== undefined)
            usage.total = sum;
    }
}

function flushUsage(usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    seen: boolean;
    inputIncomplete: boolean;
    outputIncomplete: boolean;
}): AgentEvent | undefined {
    if (!usage.seen)
        return undefined;
    const inputComplete = !usage.inputIncomplete;
    const outputComplete = !usage.outputIncomplete;
    if (!inputComplete && !outputComplete)
        return undefined;
    const data: Record<string, unknown> = { duration_ms: 0 };
    if (inputComplete)
        data.input_tokens = usage.input;
    if (outputComplete)
        data.output_tokens = usage.output;
    if (inputComplete && outputComplete) {
        if (usage.cacheRead > 0)
            data.cache_read_input_tokens = usage.cacheRead;
        if (usage.cacheWrite > 0)
            data.cache_creation_input_tokens = usage.cacheWrite;
        if (usage.total > 0)
            data.total_tokens = usage.total;
    }
    return turnUsageRecord(data);
}

/**
 * Decode Pi JSONL records into shared agent events. Terminal success requires
 * `agent_end` (or `agent_settled`) without abort, a final assistant `message_end` with stopReason
 * `stop`, and a clean process exit.
 */
export async function* decodePi(events: AsyncIterable<StreamChunk>): AsyncGenerator<AgentEvent> {
    let sessionId: string | undefined;
    let output = '';
    let finalMessageFailed = false;
    let settled = false;
    let settledAborted = false;
    let finalAssistantStop: string | undefined;
    const usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        seen: false,
        inputIncomplete: false,
        outputIncomplete: false,
    };
    const terminalFailure = (exitCode: number | null, signal: NodeJS.Signals | null): boolean => {
        if (finalMessageFailed || settledAborted || !settled)
            return true;
        if (exitCode !== 0 || signal !== null)
            return true;
        if (!finalAssistantStop)
            return true;
        const normalized = normalizeStopReason(finalAssistantStop);
        if (FAILED_STOP_REASONS.has(normalized))
            return true;
        return !SUCCESSFUL_STOP_REASONS.has(normalized);
    };
    for await (const item of readNativeRecords(events)) {
        if (item.kind === 'event') {
            if (item.event.type === 'exit') {
                const terminal = flushUsage(usage);
                if (terminal)
                    yield terminal;
                yield finishedEvent('pi', sessionId, output, terminalFailure(item.event.exitCode, item.event.signal));
            }
            yield item.event;
            continue;
        }
        const record = item.record;
        const id = sessionIdOf(record);
        if (id)
            sessionId = id;
        const session = recordOf(record, 'session');
        if (session) {
            const sessionRecordId = sessionIdOf(session);
            if (sessionRecordId)
                sessionId = sessionRecordId;
        }
        const type = stringOf(record, 'type');
        if (type === 'session') {
            const sid = stringOf(record, 'id');
            if (sid)
                sessionId = sid;
            continue;
        }
        if (type === 'message_end') {
            const message = recordOf(record, 'message');
            if (message && stringOf(message, 'role') === 'assistant') {
                const text = assistantText(message);
                if (text) {
                    output = text;
                    yield messageEvent(text);
                }
                const stopReason = stringOf(record, 'stopReason') || stringOf(message, 'stopReason');
                finalAssistantStop = stopReason;
                const errorMessage = stringOf(record, 'errorMessage') || stringOf(message, 'errorMessage');
                finalMessageFailed = Boolean(errorMessage) || Boolean(stopReason && FAILED_STOP_REASONS.has(normalizeStopReason(stopReason)));
                if (errorMessage) {
                    yield { type: 'error', message: errorMessage };
                }
                observeMessageUsage(usage, recordOf(record, 'usage') ?? recordOf(message, 'usage'));
            }
            continue;
        }
        if (type === 'tool_execution_start') {
            const callId = stringOf(record, 'toolCallId') || stringOf(record, 'tool_call_id');
            const name = stringOf(record, 'toolName') || stringOf(record, 'tool_name');
            if (callId && name) {
                yield toolCallRecord(name, callId, jsonStringValue(record.args), sessionId);
            }
            continue;
        }
        if (type === 'tool_execution_end') {
            const callId = stringOf(record, 'toolCallId') || stringOf(record, 'tool_call_id');
            if (callId) {
                const isError = record.isError === true;
                const result = jsonStringValue(record.result);
                yield toolResultRecord(callId, isError ? 'error' : 'ok', result, sessionId);
            }
            continue;
        }
        // Pi 0.73 ends a run with agent_end; agent_settled is accepted for other versions.
        if (type === 'agent_settled' || type === 'agent_end') {
            settled = true;
            if (record.aborted === true)
                settledAborted = true;
            continue;
        }
        if (type === 'error') {
            finalMessageFailed = true;
            const message = stringOf(record, 'errorMessage') || stringOf(record, 'message');
            if (message)
                yield { type: 'error', message };
            continue;
        }
    }
}
