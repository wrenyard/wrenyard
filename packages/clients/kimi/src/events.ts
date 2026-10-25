import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentEvent, StreamChunk } from '@wrenyard/agent-client';
import {
    readNativeRecords, recordOf, runFinishedRecord, sessionIdOf, stringOf, toolCallRecord, toolResultRecord,
    turnUsageRecord,
} from '@wrenyard/agent-client/native';
import { addUsageTokens, nonnegativeInt } from '@wrenyard/agent-client/statistics';

/**
 * Decode the Kimi Code native stream-json transcript plus its session wire
 * file. Stdout carries assistant content, tool calls/results, retry status and
 * a trailing resume hint; token usage, the real upstream model, the turn-end
 * reason and first-token latency only exist in the session's
 * `agents/main/wire.jsonl`, so they are read leniently when the run ends —
 * including on cancel and failure. The run home is deleted before the
 * terminal exit event reaches this decoder, so the owned-home preserve hook
 * captures the wire tail and session id first and hands them over through
 * `captured`. A field the wire does not report stays missing and is never
 * estimated.
 */
export interface DecodeKimiOptions {
    /** Exact upstream wire id the launch requested; a mismatch fails the run. */
    readonly expectedModel: string;
    /** The Wrenyard-owned KIMI_CODE_HOME of this run. */
    readonly runHome: string;
    /** Byte offset where this run's wire records start (resumed sessions). */
    readonly skipWireBytes: number;
    /** Facts the preserve hook captured before the run home was deleted. */
    readonly captured: KimiRunCapture;
}

/** Wire facts and session id captured while the run home still existed. */
export interface KimiRunCapture {
    facts?: WireFacts;
    sessionId?: string;
}

/** Wire protocol version observed during the 2026-10 integration probe. */
const KNOWN_WIRE_PROTOCOL_VERSION = '1.5';

/** Partition accumulators; an unreported partition stays incomplete. */
interface UsageAccumulator {
    input: number | undefined;
    output: number | undefined;
    cacheRead: number | undefined;
    cacheCreation: number | undefined;
    /** True once any usage record was observed, even one with no valid partitions. */
    seenAny: boolean;
}

/** What the wire file proved about the run, all optional. */
interface WireFacts {
    usage: UsageAccumulator;
    model?: string;
    thinkingEffort?: string;
    endReason?: string;
    aborted?: boolean;
    firstTokenLatencyMs?: number;
    protocolVersion?: string;
    quotaRetryAfterMs?: number;
}

export function decodeKimi(options: DecodeKimiOptions): (events: AsyncIterable<StreamChunk>) => AsyncGenerator<AgentEvent> {
    return async function* (events: AsyncIterable<StreamChunk>): AsyncGenerator<AgentEvent> {
        let sessionId: string | undefined;
        let output = '';
        let emittedTerminal = false;
        let stderrText = '';
        for await (const item of readNativeRecords(events)) {
            if (item.kind === 'event') {
                if (item.event.type === 'stderr')
                    stderrText += item.event.text;
                if (item.event.type === 'exit') {
                    // The preserve hook captured the wire tail before the run
                    // home was removed; a live read remains the fallback for a
                    // home that was never cleaned (e.g. unconfirmed tree kill).
                    const facts = options.captured.facts ?? await readWireFacts(options.runHome, options.skipWireBytes);
                    if (facts.protocolVersion !== undefined && facts.protocolVersion !== KNOWN_WIRE_PROTOCOL_VERSION)
                        yield { type: 'stderr', text: `kimi: wire protocol version ${facts.protocolVersion} was not observed before; fields may have moved` };
                    // A silent upstream fallback (e.g. an unknown wire id falling
                    // back to K2.8) is a failed run even when the exit code is 0.
                    const modelMismatch = facts.model !== undefined && facts.model !== options.expectedModel;
                    const completed = facts.endReason === 'completed';
                    const failed = modelMismatch
                        || (!completed && !facts.aborted)
                        || item.event.exitCode !== 0
                        || item.event.signal !== null;
                    if (facts.usage.seenAny) {
                        const usage = wireUsageRecord(facts.usage, facts);
                        if (usage)
                            yield usage;
                    }
                    if (sessionId === undefined)
                        sessionId = options.captured.sessionId ?? await discoverSessionId(options.runHome);
                    if (!emittedTerminal) {
                        emittedTerminal = true;
                        if (failed) {
                            const failure = kimiFailure(facts, stderrText, modelMismatch, options.expectedModel);
                            yield runFinishedRecord('kimi', 'failed', sessionId, failure);
                        } else {
                            // The success record carries the wire's observed
                            // upstream identity so downstream statistics see the
                            // model and effort that actually ran.
                            yield runFinishedRecord('kimi', 'done', sessionId, {
                                is_error: false,
                                ...(output ? { output } : {}),
                                ...(facts.model !== undefined ? { wire_model: facts.model } : {}),
                                ...(facts.thinkingEffort !== undefined ? { wire_thinking_effort: facts.thinkingEffort } : {}),
                            });
                        }
                    }
                }
                yield item.event;
                continue;
            }
            const record = item.record;
            const id = sessionIdOf(record);
            if (id)
                sessionId = id;
            const type = stringOf(record, 'type');
            if (type === 'assistant') {
                const text = assistantText(record);
                if (text) {
                    output = text;
                    yield { type: 'message', role: 'assistant', text };
                }
                for (const event of assistantToolCalls(record))
                    yield event;
                continue;
            }
            if (type === 'tool') {
                const event = toolResultEvent(record);
                if (event)
                    yield event;
                continue;
            }
            if (type === 'turn.step.retrying') {
                const attempt = nonnegativeInt(record.failed_attempt);
                const max = nonnegativeInt(record.max_attempts);
                yield { type: 'stderr', text: `kimi: upstream retry${attempt !== undefined ? ` ${attempt}${max !== undefined ? `/${max}` : ''}` : ''}: ${stringOf(record, 'error_name') || stringOf(record, 'error') || 'unknown error'}` };
                continue;
            }
            if (type === 'session.resume_hint') {
                const id = resumeHintSessionId(record);
                if (id)
                    sessionId = id;
                continue;
            }
            // `system.version` and unknown record types carry no turn state.
        }
    };
}

/**
 * Read the run home's wire facts and session id while it still exists. Called
 * by the owned-home preserve hook immediately before cleanup, so the decoder
 * can report usage, the real model and the resume session id after the home
 * is gone.
 */
export async function captureKimiRunHome(runHome: string, skipWireBytes: number): Promise<{ facts: WireFacts; sessionId?: string }> {
    return {
        facts: await readWireFacts(runHome, skipWireBytes),
        sessionId: await discoverSessionId(runHome),
    };
}

/** Assistant text from a content string or an array of typed content blocks. */
function assistantText(record: Record<string, unknown>): string {
    const message = recordOf(record, 'message') ?? record;
    const content = message.content;
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content.map((block) => {
            if (!block || typeof block !== 'object')
                return '';
            const item = block as Record<string, unknown>;
            return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
        }).join('');
    }
    return '';
}

/** OpenAI-format `tool_calls` on an assistant message, as paired call records. */
function* assistantToolCalls(record: Record<string, unknown>): Generator<AgentEvent> {
    const message = recordOf(record, 'message') ?? record;
    const calls = message.tool_calls;
    if (!Array.isArray(calls))
        return;
    for (const call of calls) {
        if (!call || typeof call !== 'object' || Array.isArray(call))
            continue;
        const entry = call as Record<string, unknown>;
        const fn = recordOf(entry, 'function');
        const name = stringOf(fn, 'name') || stringOf(entry, 'name');
        if (!name.trim())
            continue;
        const callId = stringOf(entry, 'id') || `kimi_${name}`;
        const args = fn?.arguments;
        const inputSummary = typeof args === 'string' ? args : args === undefined || args === null ? '' : JSON.stringify(args);
        yield toolCallRecord(name, callId, inputSummary, undefined);
    }
}

/** A tool result record keyed by its call id, when one is present. */
function toolResultEvent(record: Record<string, unknown>): AgentEvent | undefined {
    const callId = stringOf(record, 'call_id') || stringOf(record, 'tool_call_id') || stringOf(record, 'id');
    if (!callId)
        return undefined;
    const content = record.content ?? record.output ?? record.result;
    const text = typeof content === 'string' ? content : content === undefined || content === null ? '' : JSON.stringify(content);
    const isError = record.is_error === true || record.error !== undefined;
    return toolResultRecord(callId, isError ? 'error' : 'ok', text, undefined);
}

/** Session id carried by the trailing `session.resume_hint` record. */
function resumeHintSessionId(record: Record<string, unknown>): string | undefined {
    for (const key of ['session_id', 'sessionId', 'id']) {
        const value = stringOf(record, key);
        if (value)
            return value;
    }
    const nested = recordOf(record, 'session');
    if (nested)
        return resumeHintSessionId(nested);
    return undefined;
}

/**
 * Read the run's session wire file leniently. The run home holds exactly one
 * session; any missing field, directory or parse failure simply stays missing.
 * On a resumed session only bytes appended after `skipBytes` are parsed — a
 * file that did not grow past the recorded offset yields no records at all,
 * never a replay of the previous turn's wire.
 */
async function readWireFacts(runHome: string, skipBytes: number): Promise<WireFacts> {
    const facts: WireFacts = { usage: { input: undefined, output: undefined, cacheRead: undefined, cacheCreation: undefined, seenAny: false } };
    let wirePath: string | undefined;
    try {
        for (const wd of await readdir(join(runHome, 'sessions'))) {
            for (const session of await readdir(join(runHome, 'sessions', wd))) {
                const candidate = join(runHome, 'sessions', wd, session, 'agents', 'main', 'wire.jsonl');
                const info = await stat(candidate).catch(() => undefined);
                if (info?.isFile()) {
                    wirePath = candidate;
                    break;
                }
            }
            if (wirePath)
                break;
        }
    } catch {
        return facts;
    }
    if (!wirePath)
        return facts;
    let raw = '';
    try {
        const buffer = await readFile(wirePath);
        if (buffer.length > skipBytes)
            raw = buffer.subarray(skipBytes).toString('utf8');
    } catch {
        return facts;
    }
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        let record: Record<string, unknown>;
        try {
            const value: unknown = JSON.parse(trimmed);
            if (!value || typeof value !== 'object' || Array.isArray(value))
                continue;
            record = value as Record<string, unknown>;
        } catch {
            continue;
        }
        observeWireRecord(facts, record);
    }
    return facts;
}

/** Fold one wire record into the accumulated facts. Unknown shapes are ignored. */
function observeWireRecord(facts: WireFacts, record: Record<string, unknown>): void {
    const version = record.protocol_version;
    if (typeof version === 'string' && facts.protocolVersion === undefined)
        facts.protocolVersion = version;
    const type = stringOf(record, 'type');
    if (type === 'llm.request') {
        const model = stringOf(record, 'model');
        if (model)
            facts.model = model;
        const effort = stringOf(record, 'thinkingEffort');
        if (effort)
            facts.thinkingEffort = effort;
        return;
    }
    if (type === 'turn.ended') {
        const reason = stringOf(record, 'reason');
        if (reason)
            facts.endReason = reason;
        return;
    }
    if (type === 'prompt.aborted') {
        facts.aborted = true;
        return;
    }
    if (type === 'usage.record') {
        const source = recordOf(record, 'usage') ?? record;
        observeUsagePartitions(facts, source);
        return;
    }
    if (type === 'context.append_loop_event') {
        // Per-step usage and first-token latency travel nested inside the
        // loop event envelope as a `step.end` payload.
        const event = recordOf(record, 'event');
        if (event && stringOf(event, 'type') === 'step.end') {
            observeUsagePartitions(facts, recordOf(event, 'usage') ?? event);
            const latency = nonnegativeInt(event.llmFirstTokenLatencyMs);
            if (latency !== undefined && facts.firstTokenLatencyMs === undefined)
                facts.firstTokenLatencyMs = latency;
        }
        return;
    }
    const latency = nonnegativeInt(record.llmFirstTokenLatencyMs);
    if (latency !== undefined && facts.firstTokenLatencyMs === undefined)
        facts.firstTokenLatencyMs = latency;
    // A quota-exhausted rejection carries its upstream identity on wire error
    // records; keep the explicit retry-after hint when the CLI reported one.
    const retryAfter = nonnegativeInt(record.retryAfterMs);
    if (retryAfter !== undefined && facts.quotaRetryAfterMs === undefined)
        facts.quotaRetryAfterMs = retryAfter;
}

/** Folds one usage object's four partitions into the accumulated facts. */
function observeUsagePartitions(facts: WireFacts, source: Record<string, unknown>): void {
    facts.usage.input = addPartition(facts.usage.input, source.inputOther);
    facts.usage.output = addPartition(facts.usage.output, source.output);
    facts.usage.cacheRead = addPartition(facts.usage.cacheRead, source.inputCacheRead);
    facts.usage.cacheCreation = addPartition(facts.usage.cacheCreation, source.inputCacheCreation);
    facts.usage.seenAny = true;
}

/** Adds one observed partition value; a missing or invalid value keeps it incomplete. */
function addPartition(current: number | undefined, value: unknown): number | undefined {
    const parsed = nonnegativeInt(value);
    if (parsed === undefined)
        return current;
    return addUsageTokens(current ?? 0, parsed);
}

/**
 * Build the canonical turn_usage record. Each partition is emitted only when
 * the wire measured it; a measured zero stays a measured value. The wire's
 * own upstream model and effort ride along so the statistics projection can
 * consume the identity that actually served the turn.
 */
function wireUsageRecord(usage: UsageAccumulator, facts: WireFacts): AgentEvent | undefined {
    const data: Record<string, unknown> = {
        // The wire has no measured full-turn interval, so the canonical
        // emission carries the truthful non-positive placeholder.
        duration_ms: 0,
    };
    if (usage.input !== undefined)
        data.input_tokens = usage.input;
    if (usage.output !== undefined)
        data.output_tokens = usage.output;
    if (usage.cacheRead !== undefined)
        data.cache_read_input_tokens = usage.cacheRead;
    if (usage.cacheCreation !== undefined)
        data.cache_creation_input_tokens = usage.cacheCreation;
    if (facts.firstTokenLatencyMs !== undefined)
        data.first_token_latency_ms = facts.firstTokenLatencyMs;
    if (facts.model !== undefined)
        data.wire_model = facts.model;
    if (facts.thinkingEffort !== undefined)
        data.wire_thinking_effort = facts.thinkingEffort;
    return turnUsageRecord(data);
}

/** Session id taken from the run home's single session directory. */
async function discoverSessionId(runHome: string): Promise<string | undefined> {
    try {
        for (const wd of await readdir(join(runHome, 'sessions'))) {
            for (const session of await readdir(join(runHome, 'sessions', wd))) {
                const info = await stat(join(runHome, 'sessions', wd, session)).catch(() => undefined);
                if (info?.isDirectory())
                    return session;
            }
        }
    } catch {
        return undefined;
    }
    return undefined;
}

/**
 * Failure payload for a failed run. The wire's upstream identity leads; the
 * stderr first line (`error: failed to run prompt: <code>: <message>`)
 * supplements it. A quota-exhausted 429 and an authentication 401 map onto
 * the existing native failure classes, and the quota recovery instant rides
 * on the shared `error.resets_at` contract.
 */
function kimiFailure(facts: WireFacts, stderrText: string, modelMismatch: boolean, expectedModel: string): Record<string, unknown> {
    const stderrFirstLine = stderrText.split(/\r?\n/, 1)[0]?.trim() || '';
    const parsed = parsePromptError(stderrFirstLine);
    const code = parsed?.code ?? '';
    const status = readStatus(stderrFirstLine);
    const quotaExhausted = (status === 429 && code.includes('quota')) || code === 'exceeded_current_quota_error' || facts.quotaRetryAfterMs !== undefined;
    const authFailed = status === 401 || code === 'provider.auth_error';
    const message = modelMismatch
        ? `kimi ran upstream model ${facts.model} instead of the requested ${expectedModel}`
        : parsed?.message || stderrFirstLine || 'Kimi Code run failed';
    const error: Record<string, unknown> = { message };
    if (status !== undefined)
        error.status = status;
    if (parsed?.code)
        error.type = parsed.code;
    if (quotaExhausted && facts.quotaRetryAfterMs !== undefined && Number.isFinite(facts.quotaRetryAfterMs))
        error.resets_at = new Date(Date.now() + facts.quotaRetryAfterMs).toISOString();
    const data: Record<string, unknown> = {
        is_error: true,
        error,
        ...(quotaExhausted ? { failure_class: 'quota_exhausted' } : {}),
        ...(authFailed && !quotaExhausted ? { failure_class: 'auth_failed' } : {}),
        ...(facts.model !== undefined ? { wire_model: facts.model } : {}),
        ...(facts.thinkingEffort !== undefined ? { wire_thinking_effort: facts.thinkingEffort } : {}),
    };
    return data;
}

/** `error: failed to run prompt: <code>: <message>` from the stderr first line. */
function parsePromptError(line: string): { code: string; message: string } | undefined {
    const match = /^error: failed to run prompt: ([^:]+): (.+)$/u.exec(line);
    if (!match)
        return undefined;
    return { code: match[1]!.trim(), message: match[2]!.trim() };
}

/** An explicit HTTP status marker on the stderr line, when present. */
function readStatus(line: string): number | undefined {
    const match = /\b(4\d{2}|5\d{2})\b/u.exec(line);
    const status = match === null ? undefined : Number(match[1]);
    return status !== undefined && Number.isInteger(status) ? status : undefined;
}
