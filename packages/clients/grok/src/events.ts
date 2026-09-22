import type { AgentEvent, StreamChunk } from '@wrenyard/agent-client';
import {
    failureRecord, finishedEvent, jsonStringValue, messageEvent, readNativeRecords, recordOf, sessionIdOf, stringOf, toolCallRecord, toolResultRecord,
    turnUsageRecord,
} from '@wrenyard/agent-client/native';
import { positiveInt } from '@wrenyard/agent-client/statistics';

/**
 * Decode the native Grok streaming-json transcript.
 *
 * Grok emits one `text` record per token/subword, so text deltas are buffered
 * and flushed once per response boundary rather than forwarded as one message
 * card per fragment. It also emits early per-response usage before one final
 * end aggregate, so usage is buffered last-wins and exactly one canonical
 * turn_usage is emitted at finalization, before the single terminal record.
 */
export async function* decodeGrok(events: AsyncIterable<StreamChunk>): AsyncGenerator<AgentEvent> {
    let sessionId: string | undefined;
    let output = '';
    let message = '';
    let usage: Record<string, unknown> | undefined;
    let terminal: AgentEvent | undefined;
    let failed = false;
    let ended = false;
    let finalized = false;
    const flushMessage = (): AgentEvent | undefined => {
        if (!message)
            return undefined;
        const text = message;
        message = '';
        output += text;
        return messageEvent(text);
    };
    for await (const item of readNativeRecords(events)) {
        if (item.kind === 'event') {
            if (item.event.type === 'error') {
                failed = true;
                ended = true;
            }
            if (item.event.type === 'exit') {
                if (!finalized) {
                    finalized = true;
                    const text = flushMessage();
                    if (text)
                        yield text;
                    const canonical = canonicalUsage(usage);
                    if (canonical)
                        yield canonical;
                    if (terminal)
                        yield terminal;
                    else
                        yield finishedEvent('grok', sessionId, output, failed || !ended || item.event.exitCode !== 0 && item.event.exitCode !== null);
                }
            }
            yield item.event;
            continue;
        }
        const record = item.record;
        const id = sessionIdOf(record);
        if (id)
            sessionId = id;
        const type = stringOf(record, 'type').toLowerCase().trim();
        if (['text', 'text_delta', 'output_text'].includes(type)) {
            const text = stringOf(record, 'data');
            if (text)
                message += text;
            continue;
        }
        const flushed = flushMessage();
        if (flushed)
            yield flushed;
        const nativeUsage = grokUsage(record);
        if (nativeUsage)
            usage = nativeUsage;
        if (type === 'tool_call') {
            const event = toolCallEvent(record);
            if (event)
                yield event;
            continue;
        }
        if (type === 'tool_call_update') {
            const event = toolResultEvent(record);
            if (event)
                yield event;
            continue;
        }
        if (['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(type)) {
            failed = true;
            ended = true;
            terminal = { type: 'output', record: failureRecord(record, 'Grok runtime failed', sessionId) };
            continue;
        }
        if (['result', 'run_finished', 'done', 'complete', 'completed', 'end'].includes(type)) {
            if (!ended) {
                ended = true;
                const status = terminalStatus(type, record);
                const id = stringOf(record, 'session_id') || stringOf(record, 'sessionId') || stringOf(record, 'native_session_id') || stringOf(record, 'conversation_id');
                if (id)
                    sessionId = id;
                failed = status === 'failed';
                terminal = {
                    type: 'output',
                    record: {
                        type: 'run_finished',
                        status: failed ? 'failed' : 'done',
                        client_family: 'grok',
                        ...(failed ? { error: jsonStringValue(record.error) || jsonStringValue(record.message) || 'Grok runtime failed' } : {}),
                        ...(sessionId ? { native_session_id: sessionId } : {}),
                    },
                };
            }
        }
    }
    if (!finalized) {
        const text = flushMessage();
        if (text)
            yield text;
        const canonical = canonicalUsage(usage);
        if (canonical)
            yield canonical;
        if (terminal)
            yield terminal;
    }
}

/**
 * Emits the single canonical turn_usage for a finalized Grok stream: exactly
 * one record, carrying the last/best native usage with an explicit positive
 * native duration preserved and a guarantee that duration_ms is present.
 *
 * Grok reports no turn duration, and no trusted measured interval exists in
 * this line decoder, so no agent_turn_v1 claim is attached: the usage is
 * emitted unscoped rather than with a fabricated or guessed scope.
 */
function canonicalUsage(candidate: Record<string, unknown> | undefined): AgentEvent | undefined {
    if (!candidate)
        return undefined;
    const data = { ...candidate };
    // An explicit positive native duration is preserved; every other case
    // carries the truthful non-positive placeholder rather than an invented
    // interval. duration_ms is always present so the record is structurally
    // complete.
    data.duration_ms = positiveInt(data.duration_ms) ?? 0;
    return { type: 'output', record: turnUsageRecord(data) };
}

/** Reads a native usage object verbatim; Grok reports no turn duration. */
function grokUsage(record: Record<string, unknown>): Record<string, unknown> | undefined {
    for (const key of ['usage', 'token_usage'] as const) {
        const usage = recordOf(record, key);
        if (usage)
            return { ...usage };
    }
    return undefined;
}

function toolCallEvent(record: Record<string, unknown>): AgentEvent | undefined {
    const callId = stringOf(record, 'toolCallId').trim();
    if (!callId)
        return undefined;
    const name = stringOf(record, 'toolName') || stringOf(record, 'title') || stringOf(record, 'kind');
    const sessionId = stringOf(record, 'session_id') || stringOf(record, 'sessionId') || stringOf(record, 'native_session_id') || stringOf(record, 'conversation_id');
    return { type: 'output', record: toolCallRecord(name, callId, jsonStringValue(record.rawInput), sessionId || undefined) };
}

function toolResultEvent(record: Record<string, unknown>): AgentEvent | undefined {
    const callId = stringOf(record, 'toolCallId').trim();
    if (!callId)
        return undefined;
    const status = toolResultStatus(stringOf(record, 'status'));
    if (!status)
        return undefined;
    const output = jsonStringValue(record.rawOutput) || jsonStringValue(record.content);
    const sessionId = stringOf(record, 'session_id') || stringOf(record, 'sessionId') || stringOf(record, 'native_session_id') || stringOf(record, 'conversation_id');
    return { type: 'output', record: toolResultRecord(callId, status, output, sessionId || undefined) };
}

function toolResultStatus(status: string): 'ok' | 'error' | undefined {
    switch (status.toLowerCase().trim()) {
        case 'completed':
        case 'complete':
        case 'done':
        case 'success':
        case 'succeeded':
            return 'ok';
        case 'error':
        case 'failed':
        case 'failure':
        case 'cancelled':
        case 'canceled':
            return 'error';
        default:
            return undefined;
    }
}

/** Classifies a Grok terminal record; an unrecognized shape leaves the stream non-terminal. */
function terminalStatus(type: string, record: Record<string, unknown>): 'done' | 'failed' | '' {
    if (record.is_error === true)
        return 'failed';
    const status = stringOf(record, 'status').toLowerCase().trim();
    if (['done', 'success', 'complete', 'completed'].includes(status))
        return 'done';
    if (['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(status))
        return 'failed';
    if (type === 'end') {
        const stopReason = stringOf(record, 'stopReason').toLowerCase().trim();
        if (stopReason === 'endturn' || stopReason === 'end_turn')
            return 'done';
        if (['error', 'fail', 'cancel'].some((needle) => stopReason.includes(needle)))
            return 'failed';
        return '';
    }
    if (type === 'result' || type === 'run_finished' || type === 'done' || type === 'complete' || type === 'completed')
        return 'done';
    return '';
}
