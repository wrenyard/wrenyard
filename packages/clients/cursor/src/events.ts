import { turnUsageRecord } from '@wrenyard/agent-client/native';
import type { AgentEvent, StreamChunk } from '@wrenyard/agent-client';
import {
    finishedEvent, jsonStringValue, messageEvent, readNativeRecords, recordOf, sessionIdOf, stringOf, toolCallRecord, toolResultRecord,
} from '@wrenyard/agent-client/native';
import {
    CursorAssistantTextDeduper, CursorTpsSampler, attachTpsSamples, completeUsageTokens, nonnegativeInt, positiveInt,
} from '@wrenyard/agent-client/statistics';

/**
 * Decode the Cursor native stream-json transcript.
 *
 * Cursor emits assistant text as real deltas plus periodic aggregate summary
 * flushes, so text is reconstructed through the shared lookahead deduper and
 * emitted once per response boundary. The whole turn's structure is tracked by
 * the Cursor sampler: one successfully terminal turn with at least one
 * observable serial generation window yields exactly one aggregate
 * tokenizer_v1 sample, while any structural surprise yields none.
 */
export async function* decodeCursor(events: AsyncIterable<StreamChunk>): AsyncGenerator<AgentEvent> {
    let sessionId: string | undefined;
    let output = '';
    let finished = false;
    const sampler = new CursorTpsSampler();
    const deduper = new CursorAssistantTextDeduper();
    let message = '';
    // The turn's official usage and terminal are buffered until the stream
    // ends so usage is always emitted before the single terminal record.
    let usage: Record<string, unknown> | undefined;
    let terminal: { failed: boolean } | undefined;
    let endReason = '';
    const flushMessage = (): AgentEvent | undefined => {
        if (!message)
            return undefined;
        const text = message;
        message = '';
        output = text;
        return messageEvent(text);
    };
    for await (const item of readNativeRecords(events)) {
        if (item.kind === 'event') {
            if (item.event.type === 'error' && !endReason)
                endReason = item.event.message ?? 'cursor execution failed';
            else if (item.event.type === 'exit' && !endReason && item.event.exitCode !== 0 && item.event.exitCode !== null)
                endReason = `cursor exited with code ${item.event.exitCode}`;
            if (item.event.type === 'exit') {
                const text = deduper.finish();
                if (text)
                    message += text;
                const flushed = flushMessage();
                if (flushed)
                    yield flushed;
                if (usage)
                    yield { type: 'output', record: turnUsageRecord(withSample(usage, sampler)) };
                yield finishedEvent('cursor', sessionId, output, endReason !== '' || !terminal || terminal.failed);
            }
            yield item.event;
            continue;
        }
        const record = item.record;
        sampler.observe(record);
        const text = deduper.observe(record);
        if (text)
            message += text;
        const id = sessionIdOf(record);
        if (id)
            sessionId = id;
        const type = stringOf(record, 'type').toLowerCase();
        // Real deltas accumulate; only events that end a response boundary
        // flush the aggregate message, so the transcript carries one card per
        // response rather than one per delta.
        if (type === 'tool_call' || type === 'result' || type === 'run_finished' || type === 'error' || type === 'failed') {
            const flushed = flushMessage();
            if (flushed)
                yield flushed;
        }
        if (type === 'tool_call') {
            const event = toolEvent(record);
            if (event)
                yield event;
            continue;
        }
        if (type === 'result' || type === 'run_finished' || type === 'error' || type === 'failed') {
            if (!terminal) {
                terminal = { failed: terminalFailed(type, record) };
                const id = cursorSessionId(record);
                if (id)
                    sessionId = id;
                usage = cursorUsage(record) ?? usage;
            }
        }
    }
    // A stream that ended without any exit chunk still flushes its pending text.
    const tail = deduper.finish();
    if (tail)
        message += tail;
    const flushed = flushMessage();
    if (flushed)
        yield flushed;
}

/** Attaches the aggregate sample only when the terminal usage is itself complete. */
function withSample(usage: Record<string, unknown>, sampler: CursorTpsSampler): Record<string, unknown> {
    const data = { ...usage };
    if (completeUsageTokens(data)) {
        const sample = sampler.finalize(data, '');
        if (sample)
            attachTpsSamples(data, [sample]);
    }
    return data;
}

/** Normalizes a Cursor tool_call record by its subtype. */
function toolEvent(record: Record<string, unknown>): AgentEvent | undefined {
    const subtype = stringOf(record, 'subtype').toLowerCase();
    const callId = stringOf(record, 'call_id').trim();
    if (!callId)
        return undefined;
    if (subtype === 'started') {
        const [name, input] = toolIdentity(record);
        return { type: 'output', record: toolCallRecord(name, callId, input) };
    }
    if (subtype === 'completed') {
        const { status, output } = toolOutcome(record);
        return { type: 'output', record: toolResultRecord(callId, status, output) };
    }
    return undefined;
}

/** Reads the single nested *ToolCall object and derives a snake_case tool name. */
function toolCallObject(record: Record<string, unknown>): { name: string; args: unknown } | undefined {
    const container = recordOf(record, 'tool_call');
    if (!container)
        return undefined;
    let key = '';
    let inner: Record<string, unknown> | undefined;
    for (const [candidateKey, value] of Object.entries(container)) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            continue;
        // More than one *ToolCall object is not the canonical wire shape.
        if (inner)
            return undefined;
        inner = value as Record<string, unknown>;
        key = candidateKey;
    }
    if (!inner)
        return undefined;
    return { name: snakeToolName(key), args: inner.args };
}

/** Converts a camelCase *ToolCall key such as shellToolCall into shell_tool_call. */
function snakeToolName(key: string): string {
    let out = '';
    for (let index = 0; index < key.length; index++) {
        const char = key[index]!;
        if (char >= 'A' && char <= 'Z') {
            if (index > 0)
                out += '_';
            out += char.toLowerCase();
        }
        else {
            out += char;
        }
    }
    return out;
}

function toolIdentity(record: Record<string, unknown>): [string, string] {
    const call = toolCallObject(record);
    if (!call)
        return ['cursor_tool', ''];
    return [call.name || 'cursor_tool', jsonStringValue(call.args)];
}

function toolOutcome(record: Record<string, unknown>): { status: 'ok' | 'error'; output: string } {
    const container = recordOf(record, 'tool_call');
    if (!container)
        return { status: 'error', output: '' };
    let inner: Record<string, unknown> | undefined;
    for (const value of Object.values(container)) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            continue;
        if (inner)
            return { status: 'error', output: '' };
        inner = value as Record<string, unknown>;
    }
    if (!inner)
        return { status: 'error', output: '' };
    const result = recordOf(inner, 'result');
    if (!result)
        return { status: 'error', output: jsonStringValue(inner) };
    const error = result.error;
    if (error !== undefined && error !== null) {
        const text = jsonStringValue(error);
        if (text)
            return { status: 'error', output: text };
    }
    const success = recordOf(result, 'success');
    if (!success)
        return { status: 'ok', output: jsonStringValue(result) };
    const stdout = stringOf(success, 'stdout');
    const stderr = stringOf(success, 'stderr');
    if (stdout && stderr)
        return { status: 'ok', output: `${stdout}\n${stderr}` };
    return { status: 'ok', output: stdout || stderr };
}

/** Maps the four native Cursor token partitions onto the common usage surface. */
function cursorUsage(record: Record<string, unknown>): Record<string, unknown> | undefined {
    const usage = recordOf(record, 'usage');
    if (!usage)
        return undefined;
    const input = nonnegativeInt(usage.inputTokens);
    const output = nonnegativeInt(usage.outputTokens);
    const cacheRead = nonnegativeInt(usage.cacheReadTokens);
    const cacheWrite = nonnegativeInt(usage.cacheWriteTokens);
    if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined)
        return undefined;
    const cached = cacheRead + cacheWrite;
    const total = input + output + cacheRead + cacheWrite;
    if (!Number.isSafeInteger(cached) || !Number.isSafeInteger(total))
        return undefined;
    return {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        cached_input_tokens: cached,
        total_tokens: total,
        duration_ms: positiveInt(record.duration_ms) ?? 0,
    };
}

/** A native failure signals through subtype=error or is_error=true. */
function terminalFailed(type: string, record: Record<string, unknown>): boolean {
    if (type === 'error' || type === 'failed')
        return true;
    if (record.is_error === true)
        return true;
    const subtype = stringOf(record, 'subtype').toLowerCase().trim();
    if (['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(subtype))
        return true;
    const status = stringOf(record, 'status').toLowerCase().trim();
    return ['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(status);
}

function cursorSessionId(record: Record<string, unknown>): string {
    for (const key of ['session_id', 'sessionId', 'native_session_id', 'conversation_id']) {
        const value = stringOf(record, key).trim();
        if (value)
            return value;
    }
    return '';
}
