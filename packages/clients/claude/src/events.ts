import { turnUsageRecord } from '@wrenyard/agent-client/native';
import type { AgentEvent, StreamChunk } from '@wrenyard/agent-client';
import {
    finishedEvent, jsonStringValue, messageEvent, readNativeRecords, recordOf, sessionIdOf, stringOf, textOf, toolCallRecord, toolResultRecord,
} from '@wrenyard/agent-client/native';
import {
    ResponseTpsSampler, TPS_CONTRACT_AGENT_TURN_V1, DURATION_SCOPE_AGENT_TURN, TOKEN_SCOPE_AGENT_TURN, completeUsageTokens, hasNormalizedFailureField,
    positiveInt,
} from '@wrenyard/agent-client/statistics';

export async function* decodeClaude(events: AsyncIterable<StreamChunk>): AsyncGenerator<AgentEvent> {
    yield* decodeClaudeFamily(events, 'claude');
}

/**
 * Decode a Claude-compatible native transcript stream.
 *
 * Full-message records are the source of normalized content and usage; the
 * partial `stream_event` envelopes are consumed only by the response sampler,
 * whose persisted sample is the fixed-tokenizer count of observed generation
 * content over its own first-to-last delta window.
 *
 * A `result` record's duration is the client-reported end-to-end agent
 * turn/session wall duration and may include tool and waiting time. It is NOT
 * provider generation time, so it never becomes a speed denominator; the
 * agent_turn_v1 contract is claimed only for a successful result with a
 * positive finite duration and complete usage.
 */
export async function* decodeClaudeFamily(events: AsyncIterable<StreamChunk>, family: string): AsyncGenerator<AgentEvent> {
    let sessionId: string | undefined;
    let output = '';
    let finished = false;
    const sampler = new ResponseTpsSampler();
    for await (const item of readNativeRecords(events)) {
        if (item.kind === 'event') {
            if (item.event.type === 'exit' && !finished)
                yield finishedEvent(family, sessionId, output, item.event.exitCode !== 0 && item.event.exitCode !== null);
            yield item.event;
            continue;
        }
        const record = item.record;
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
            const usage = recordOf(record, 'usage');
            const complete = usage ? completeUsageTokens(usage) : undefined;
            const durationMS = positiveInt(record.duration_ms);
            const failed = record.is_error === true || hasNormalizedFailureField(record);
            // Only genuinely captured counters are emitted. A partition the
            // client never reported stays absent rather than being fabricated
            // as an explicit zero, so a scope-less partial turn_usage record
            // never claims tokens that were never observed.
            const data: Record<string, unknown> = {};
            if (complete?.input !== undefined)
                data.input_tokens = complete.input;
            if (complete?.output !== undefined)
                data.output_tokens = complete.output;
            if (durationMS !== undefined)
                data.duration_ms = durationMS;
            if (!failed && durationMS !== undefined && complete) {
                data.token_scope = TOKEN_SCOPE_AGENT_TURN;
                data.duration_scope = DURATION_SCOPE_AGENT_TURN;
                data.tps_contract = TPS_CONTRACT_AGENT_TURN_V1;
            }
            if (sampler.attachable)
                sampler.takeSamples(data);
            yield { type: 'output', record: turnUsageRecord(data) };
            yield finishedEvent(family, sessionId, output, failed);
        }
    }
}

/** Normalizes an assistant message's text and tool_use blocks. */
function* assistantEvents(record: Record<string, unknown>): Generator<AgentEvent> {
    const message = recordOf(record, 'message');
    const content = message?.content;
    if (!Array.isArray(content))
        return;
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
        else if (blockType === 'tool_use') {
            yield {
                type: 'output',
                record: toolCallRecord(stringOf(block, 'name'), stringOf(block, 'id'), jsonStringValue(block.input)),
            };
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
        yield {
            type: 'output',
            record: toolResultRecord(
                stringOf(block, 'tool_use_id'),
                block.is_error === true ? 'error' : 'ok',
                toolResultText(block.content),
            ),
        };
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
