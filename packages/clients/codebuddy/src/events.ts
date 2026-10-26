import { turnUsageRecord } from '@wrenyard/agent-client/native';
import type { AgentEvent, InternalAgentEvent, StreamChunk } from '@wrenyard/agent-client';
import {
    errorValue, finishedEvent, jsonStringValue, messageEvent, readNativeRecords, reasoningRecord, recordOf, runFinishedRecord, sessionIdOf, stringOf, textOf, toolCallRecord, toolResultRecord,
} from '@wrenyard/agent-client/native';
import { ResponseTpsSampler, completeUsageTokens, hasNormalizedFailureField } from '@wrenyard/agent-client/statistics';

/**
 * Decode the CodeBuddy native transcript stream.
 *
 * CodeBuddy's stream protocol is Claude-compatible for ordinary events, so the
 * full-message records (`assistant`, `user`, `result`) are the source of
 * normalized content and legacy accounting, while the partial `stream_event`
 * envelopes exist only to time generation. The partial stream is fed to the
 * response sampler after model identity normalization, so the persisted speed sample is
 * always the fixed-tokenizer count of observed generation content over its own
 * first-to-last delta window -- never the invocation wall clock.
 */
export async function* decodeCodeBuddy(
    events: AsyncIterable<StreamChunk>,
    normalizeModel: (model: string) => string = (model) => model,
): AsyncGenerator<AgentEvent | InternalAgentEvent> {
    let sessionId: string | undefined;
    let output = '';
    let finished = false;
    const sampler = new ResponseTpsSampler();
    for await (const item of readNativeRecords(events)) {
        if (item.kind === 'event') {
            // Fail closed: a process that exits without a genuine terminal
            // result record is a protocol/initialization failure, never a
            // successful run. The captured native session id and output are
            // preserved in the failed terminal; native stderr still flows
            // through the unchanged stream path.
            if (item.event.type === 'exit' && !finished) {
                finished = true;
                const missing: string[] = [];
                if (!sessionId)
                    missing.push('no native session id');
                if (!output)
                    missing.push('no output');
                const detail = missing.length ? ` (${missing.join(', ')})` : '';
                yield runFinishedRecord('codebuddy', 'failed', sessionId, {
                        ...(output ? { output } : {}),
                        is_error: true,
                        error: `CodeBuddy exited without a terminal result${detail}`,
                    });
            }
            yield item.event;
            continue;
        }
        const record = item.record;
        const event = recordOf(record, 'event');
        for (const payload of [record, recordOf(record, 'message'), event && recordOf(event, 'message')]) {
            if (payload && typeof payload.model === 'string') payload.model = normalizeModel(payload.model);
        }
        sampler.observe(record);
        const type = stringOf(record, 'type');
        const id = sessionIdOf(record);
        if (id)
            sessionId = id;
        if (type === 'assistant') {
            for (const event of assistantEvents(record))
                yield event;
            continue;
        }
        if (type === 'user') {
            for (const event of userEvents(record))
                yield event;
            continue;
        }
        if (type === 'result' && !finished) {
            finished = true;
            const text = textOf(record);
            if (text)
                output = text;
            const usage = completeUsageTokens(recordOf(record, 'usage') ?? {});
            const failed = record.is_error === true || hasNormalizedFailureField(record);
            if (usage) {
                const data: Record<string, unknown> = {
                    input_tokens: usage.input,
                    output_tokens: usage.output,
                };
                const durationMS = typeof record.duration_ms === 'number' && Number.isFinite(record.duration_ms) ? record.duration_ms : 0;
                data.duration_ms = durationMS;
                // The delegated result is cumulative and carries no
                // independently measured invocation duration, so no
                // agent_turn_v1 claim is made here; only the streamed speed
                // sample from the partial stream is attached.
                if (sampler.attachable)
                    sampler.takeSamples(data);
                yield turnUsageRecord(data);
            }
            let terminalOutput = output;
            if (failed) {
                const textOutput = textOf(record);
                let errorText = '';
                for (const key of ['error', 'message'] as const) {
                    if (record[key] === undefined)
                        continue;
                    const value = errorValue(record[key], '');
                    if (typeof value === 'string') {
                        if (value)
                            errorText = value;
                    }
                    else if (value && typeof value === 'object' && !Array.isArray(value)) {
                        const fromObject = stringOf(value as Record<string, unknown>, 'message') || jsonStringValue(value);
                        if (fromObject)
                            errorText = fromObject;
                    }
                    if (errorText)
                        break;
                }
                if (errorText && errorText !== textOutput)
                    terminalOutput = textOutput ? `${textOutput}\n${errorText}` : errorText;
            }
            yield finishedEvent('codebuddy', sessionId, terminalOutput, failed);
        }
    }
}

/** Normalizes an assistant message's text and tool_use blocks. */
function* assistantEvents(record: Record<string, unknown>): Generator<AgentEvent> {
    const message = recordOf(record, 'message');
    const content = message?.content;
    if (!Array.isArray(content)) {
        const text = textOf(record);
        if (text)
            yield messageEvent(text);
        return;
    }
    for (const raw of content) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            continue;
        const block = raw as Record<string, unknown>;
        const blockType = stringOf(block, 'type');
        if (blockType === 'text' || blockType === 'output_text') {
            const text = stringOf(block, 'text');
            if (text)
                yield messageEvent(text);
        }
        else if (blockType === 'thinking') {
            const thinking = stringOf(block, 'thinking');
            if (thinking)
                yield reasoningRecord(thinking);
        }
        else if (blockType === 'tool_use') {
            const callId = stringOf(block, 'id');
            yield toolCallRecord(stringOf(block, 'name'), callId, jsonStringValue(block.input));
        }
    }
}

/** Normalizes a user message's tool_result blocks into tool results. */
function* userEvents(record: Record<string, unknown>): Generator<AgentEvent> {
    const message = recordOf(record, 'message');
    const content = message?.content;
    if (!Array.isArray(content))
        return;
    for (const raw of content) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            continue;
        const block = raw as Record<string, unknown>;
        if (stringOf(block, 'type') !== 'tool_result')
            continue;
        yield toolResultRecord(
                stringOf(block, 'tool_use_id'),
                block.is_error === true ? 'error' : 'ok',
                toolResultText(block.content),
            );
    }
}

/** Joins a tool_result content payload, whether it is text, a block list, or a raw value. */
export function toolResultText(raw: unknown): string {
    if (typeof raw === 'string')
        return raw;
    if (!Array.isArray(raw))
        return jsonStringValue(raw);
    let text = '';
    for (const item of raw) {
        if (typeof item === 'string') {
            text += item;
            continue;
        }
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            const block = item as Record<string, unknown>;
            text += stringOf(block, 'text') || stringOf(block, 'content') || jsonStringValue(item);
            continue;
        }
        text += jsonStringValue(item);
    }
    return text;
}
