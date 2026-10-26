import { turnUsageRecord } from '@wrenyard/agent-client/native';
import type { AgentEvent, InternalAgentEvent, StreamChunk } from '@wrenyard/agent-client';
import {
    finishedEvent, jsonStringValue, messageEvent, readNativeRecords, reasoningRecord, recordOf, sessionIdOf, stringOf, toolCallRecord, toolResultRecord,
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
 * speed sample, while any structural surprise yields none.
 */
export async function* decodeCursor(events: AsyncIterable<StreamChunk>, model: string): AsyncGenerator<AgentEvent | InternalAgentEvent> {
    let sessionId: string | undefined;
    let output = '';
    let finished = false;
    const sampler = new CursorTpsSampler();
    const deduper = new CursorAssistantTextDeduper();
    let message = '';
    // The turn's official usage and terminal are buffered until the stream
    // ends so usage is always emitted before the single terminal record.
    let usage: Record<string, unknown> | undefined;
    let terminal: { signal: string | undefined; record: Record<string, unknown> } | undefined;
    let endReason = '';
    let stderrTail = '';
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
            if (item.event.type === 'stderr')
                stderrTail = (stderrTail + item.event.text).slice(-4096);
            else if (item.event.type === 'error' && !endReason)
                endReason = item.event.message;
            if (item.event.type === 'exit' && !finished) {
                finished = true;
                const text = deduper.finish();
                if (text)
                    message += text;
                const flushed = flushMessage();
                if (flushed)
                    yield flushed;
                if (usage)
                    yield turnUsageRecord(withSample(usage, sampler, model));
                const failed = endReason !== '' || !terminal || terminal.signal !== undefined;
                let runError: Record<string, unknown> | string | undefined;
                if (failed) {
                    const stderrLine = lastNonEmptyStderrLine(stderrTail, 600);
                    if (terminal?.signal !== undefined)
                        runError = cursorTerminalError(terminal.signal, terminal.record);
                    else if (endReason !== '')
                        runError = stderrLine === '' ? endReason : `${endReason}; stderr: ${stderrLine}`;
                    else if (stderrLine !== '')
                        runError = `stderr: ${stderrLine}`;
                }
                yield finishedEvent('cursor', sessionId, output, failed, runError);
            }
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
        if (type === 'thinking') {
            const text = stringOf(record, 'text');
            if (text)
                yield reasoningRecord(text);
            continue;
        }
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
                terminal = { signal: terminalFailureSignal(type, record), record };
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
    if (!finished) {
        finished = true;
        if (usage)
            yield turnUsageRecord(withSample(usage, sampler, model));
        const failed = endReason !== '' || !terminal || terminal.signal !== undefined;
        const stderrLine = lastNonEmptyStderrLine(stderrTail, 600);
        const runError = terminal?.signal !== undefined
            ? cursorTerminalError(terminal.signal, terminal.record)
            : endReason !== '' ? (stderrLine === '' ? endReason : `${endReason}; stderr: ${stderrLine}`)
                : stderrLine !== '' ? `stderr: ${stderrLine}` : undefined;
        yield finishedEvent('cursor', sessionId, output, failed, runError);
    }
}

/** Attaches the aggregate sample only when the terminal usage is itself complete. */
function withSample(usage: Record<string, unknown>, sampler: CursorTpsSampler, model: string): Record<string, unknown> {
    const data = { ...usage };
    if (completeUsageTokens(data)) {
        const sample = sampler.finalize(data, model);
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
        return toolCallRecord(name, callId, input);
    }
    if (subtype === 'completed') {
        const { status, output } = toolOutcome(record);
        return toolResultRecord(callId, status, output);
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

const CURSOR_TERMINAL_FAILURE_VALUES = new Set(['error', 'failed', 'failure', 'cancelled', 'canceled']);

/** Returns the first native failure signal on a terminal record, if any. */
function terminalFailureSignal(type: string, record: Record<string, unknown>): string | undefined {
    if (type === 'error' || type === 'failed')
        return `type=${type}`;
    if (record.is_error === true)
        return 'is_error=true';
    const subtype = stringOf(record, 'subtype').trim();
    const normalizedSubtype = subtype.toLowerCase();
    if (CURSOR_TERMINAL_FAILURE_VALUES.has(normalizedSubtype))
        return `subtype=${subtype}`;
    const status = stringOf(record, 'status').trim();
    const normalizedStatus = status.toLowerCase();
    if (CURSOR_TERMINAL_FAILURE_VALUES.has(normalizedStatus))
        return `status=${status}`;
    return undefined;
}

/** Last non-empty line of accumulated stderr, trimmed and capped for run_finished attribution. */
function lastNonEmptyStderrLine(stderrTail: string, maxChars: number): string {
    const lines = stderrTail.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index--) {
        const trimmed = lines[index]!.trim();
        if (trimmed !== '')
            return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
    }
    return '';
}

/** Structured terminal error for run_finished, preserving Cursor's own message text. */
function cursorTerminalError(signal: string, record: Record<string, unknown>): Record<string, unknown> {
    const nested = recordOf(record, 'error');
    const message = stringOf(nested, 'message')
        || stringOf(nested, 'error')
        || (typeof record.error === 'string' ? record.error : '')
        || stringOf(record, 'message');
    return message ? { type: signal, message } : { type: signal };
}

function cursorSessionId(record: Record<string, unknown>): string {
    for (const key of ['session_id', 'sessionId', 'native_session_id', 'conversation_id']) {
        const value = stringOf(record, key).trim();
        if (value)
            return value;
    }
    return '';
}
