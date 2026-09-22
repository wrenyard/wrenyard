import { StringDecoder } from 'node:string_decoder';
import { CodexStatistics } from './statistics.ts';
import { startProcess, type ProcessSpec } from '@wrenyard/execution';
import type { AgentEvent, AgentRequest, AgentSession, OperationOptions } from '@wrenyard/agent-client';
import { finishedEvent, jsonStringValue, messageEvent, recordOf, stringOf, toolCallRecord, toolResultRecord, turnUsageRecord } from '@wrenyard/agent-client/native';
import { applyTrustedAgentTurnContract, completeUsageTokens, nonnegativeInt, positiveInt } from '@wrenyard/agent-client/statistics';

interface PendingCall {
    readonly method: string;
    resolve(value: Record<string, unknown>): void;
    reject(error: Error): void;
}

export async function startCodexSession(spec: ProcessSpec, request: AgentRequest, options?: OperationOptions): Promise<AgentSession> {
    const execution = await startProcess(spec, options);
    let settled = false;
    let resolveResult!: (value: { exitCode: number | null }) => void;
    const result = new Promise<{ exitCode: number | null }>((resolve) => { resolveResult = resolve; });
    const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        void execution.cancel().then(() => resolveResult({ exitCode }), () => resolveResult({ exitCode: 1 }));
    };
    void execution.result.then(() => { if (!settled) finish(1); });
    return {
        events: protocol(execution, request, finish),
        result,
        cancel: () => execution.cancel(),
        diagnostics: execution.diagnostics,
    };
}

async function* protocol(
    execution: Awaited<ReturnType<typeof startProcess>>,
    request: AgentRequest,
    finish: (exitCode: number | null) => void,
): AsyncGenerator<AgentEvent> {
    const pending = new Map<number, PendingCall>();
    let nextId = 1;
    const decoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const statistics = new CodexStatistics(request.model, Boolean(request.resumeSessionId));
    let buffer = '';
    let threadId = request.resumeSessionId;
    let output = '';
    let finished = false;
    let logicalExitCode = 1;
    let turnId: string | undefined;
    const complete = (failed: boolean): AgentEvent | undefined => {
        if (finished) return undefined;
        finished = true;
        logicalExitCode = failed ? 1 : 0;
        for (const waiter of pending.values()) waiter.reject(new Error('Codex turn ended'));
        pending.clear();
        finish(failed ? 1 : 0);
        execution.closeInput();
        void execution.cancel();
        return finishedEvent('codex', threadId, output, failed);
    };
    const call = (method: string, params: unknown) => {
        const id = nextId++;
        execution.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        return new Promise<Record<string, unknown>>((resolve, reject) => {
            pending.set(id, { method, resolve, reject });
        });
    };
    let sent = false;
    for await (const event of execution.events) {
        if (event.type === 'started' && !sent) {
            sent = true;
            void call('initialize', { clientInfo: { name: 'wrenyard', title: 'Wrenyard', version: '1' }, capabilities: { experimentalApi: true } })
                .then(() => {
                execution.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: null }) + '\n');
                const params: Record<string, unknown> = {
                    model: request.model, cwd: request.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access',
                    experimentalRawEvents: !request.resumeSessionId,
                };
                if (request.resumeSessionId) params.threadId = request.resumeSessionId;
                return call(request.resumeSessionId ? 'thread/resume' : 'thread/start', params);
            })
                .then((threadResult) => {
                const thread = threadResult.thread;
                if (thread && typeof thread === 'object' && typeof (thread as { id?: unknown }).id === 'string')
                    threadId = (thread as { id: string }).id;
                const turn: Record<string, unknown> = { threadId, input: [{ type: 'text', text: request.prompt }] };
                if (request.thinking) turn.effort = request.thinking;
                return call('turn/start', turn);
            })
                .catch(() => { if (!finished) void execution.cancel(); });
        }
        if (event.type === 'stderr' && event.data) {
            yield { type: 'stderr', text: stderrDecoder.write(Buffer.from(event.data)) };
            continue;
        }
        if (event.type === 'error') {
            if (finished) continue;
            yield { type: 'error', message: event.message ?? 'codex app-server failed' };
            continue;
        }
        if (event.type === 'exit') {
            if (!finished) {
                const terminal = complete(true);
                if (terminal) yield terminal;
            }
            yield { type: 'exit', exitCode: logicalExitCode, signal: null };
            return;
        }
        if (event.type !== 'stdout' || !event.data)
            continue;
        buffer += decoder.write(Buffer.from(event.data));
        if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
            const terminal = complete(true);
            if (terminal) yield terminal;
            continue;
        }
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) yield* handleLine(line);
            newline = buffer.indexOf('\n');
        }
    }

    function* handleLine(line: string): Generator<AgentEvent> {
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; }
        catch { return; }
        if (typeof message.id === 'number' && typeof message.method === 'string') {
            execution.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\n');
            return;
        }
        if (typeof message.id === 'number') {
            const waiter = pending.get(message.id);
            pending.delete(message.id);
            if (!waiter) return;
            if (message.error) {
                waiter.reject(new Error(`codex ${waiter.method} failed`));
                const terminal = complete(true);
                if (terminal) yield terminal;
                return;
            }
            waiter.resolve(message.result && typeof message.result === 'object' ? message.result as Record<string, unknown> : {});
            return;
        }
        const method = typeof message.method === 'string' ? message.method : '';
        const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : {};
        const incomingThread = params.threadId ?? params.thread_id;
        if (threadId && incomingThread && incomingThread !== threadId) return;
        const incomingTurn = params.turnId ?? params.turn_id;
        if (turnId && incomingTurn && incomingTurn !== turnId) return;
        if (method === 'turn/started') {
            const turn = recordOf(params, 'turn');
            if (typeof turn?.id === 'string') turnId = turn.id;
        }
        statistics.observe(method, params);
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string' && params.delta) {
            output += params.delta;
            yield messageEvent(params.delta);
        }
        else if (method === 'item/started' || method === 'item/completed') {
            const item = recordOf(params, 'item');
            if (item)
                yield* itemEvents(method === 'item/started' ? 'started' : 'completed', item);
        }
        else if (method === 'turn/completed') {
            const turn = recordOf(params, 'turn') ?? params;
            const failed = turn.status !== 'completed' || turn.error != null;
            const usage = statistics.finish(!failed) ?? turnUsage(params);
            if (usage)
                yield { type: 'output', record: usage };
            if (typeof params.status === 'string' && params.status === 'failed' && typeof params.error !== 'undefined') {
                yield { type: 'output', record: { type: 'run_finished', status: 'failed', error: params.error } };
            }
            const terminal = complete(failed);
            if (terminal) yield terminal;
        }
        else if (method === 'turn/failed') {
            const error = params.error;
            if (error !== undefined && error !== null)
                yield { type: 'output', record: { type: 'run_finished', status: 'failed', error } };
            const terminal = complete(true);
            if (terminal) yield terminal;
        }
        else if (method === 'error') {
            if (params.willRetry === true) return;
            const terminal = complete(true);
            if (terminal) yield terminal;
        }
    }

    /**
     * Normalizes one native Codex item lifecycle notification into the common
     * tool and message surface. `file_change` is atomic: it is emitted only at
     * its completed boundary, as a paired tool_call/tool_result, so it can
     * never be double-counted against a started boundary.
     */
    function* itemEvents(boundary: 'started' | 'completed', item: Record<string, unknown>): Generator<AgentEvent> {
        const itemType = stringOf(item, 'type');
        if (boundary === 'started') {
            if (!(itemType in CODEX_TOOL_ITEMS) || itemType === 'file_change')
                return;
            yield* toolCallEvent(item, itemType);
            return;
        }
        if (itemType === 'agent_message') {
            const text = stringOf(item, 'text') || stringOf(item, 'content');
            if (text)
                yield messageEvent(text);
            return;
        }
        if (itemType === 'file_change') {
            yield* toolCallEvent(item, itemType);
            yield* toolResultEvent(item, itemType);
            return;
        }
        if (itemType in CODEX_TOOL_ITEMS)
            yield* toolResultEvent(item, itemType);
    }

    /** Emits a tool_call record for a supported native Codex tool item. */
    function* toolCallEvent(item: Record<string, unknown>, itemType: string): Generator<AgentEvent> {
        const callId = stringOf(item, 'id').trim();
        if (!callId)
            return;
        const [name, input] = toolIdentity(item, itemType);
        yield { type: 'output', record: toolCallRecord(name, callId, input) };
    }

    /** Emits a tool_result record for a supported native Codex tool item. */
    function* toolResultEvent(item: Record<string, unknown>, itemType: string): Generator<AgentEvent> {
        const callId = stringOf(item, 'id').trim();
        if (!callId)
            return;
        const { status, output } = toolOutcome(item, itemType);
        yield { type: 'output', record: toolResultRecord(callId, status, output) };
    }
}

/** The native Codex item types that map onto the common tool surface. */
const CODEX_TOOL_ITEMS: Readonly<Record<string, true>> = {
    command_execution: true,
    mcp_tool_call: true,
    web_search: true,
    file_change: true,
};

/** Joins a command payload, whether it is a shell string or an argv list. */
function commandSummary(raw: unknown): string {
    if (Array.isArray(raw))
        return raw.map((part) => String(part)).join(' ');
    return jsonStringValue(raw);
}

/** Names a command by its executable, keeping the raw command as the summary. */
function commandName(command: string): string {
    const fields = command.trim().split(/\s+/u).filter(Boolean);
    return fields[0] || 'command_execution';
}

function toolIdentity(item: Record<string, unknown>, itemType: string): [string, string] {
    switch (itemType) {
        case 'command_execution': {
            const command = commandSummary(item.command);
            return [commandName(command), command];
        }
        case 'mcp_tool_call': {
            const name = stringOf(item, 'tool') || stringOf(item, 'tool_name');
            return [name || 'mcp_tool_call', jsonStringValue(item.arguments)];
        }
        case 'web_search':
            return ['web_search', stringOf(item, 'query')];
        case 'file_change':
            return ['file_change', fileChangeSummary(item)];
        default:
            return [itemType, jsonStringValue(item)];
    }
}

function toolOutcome(item: Record<string, unknown>, itemType: string): { status: 'ok' | 'error'; output: string } {
    switch (itemType) {
        case 'command_execution': {
            const exitCode = typeof item.exit_code === 'number' ? item.exit_code : 0;
            return { status: exitCode === 0 ? 'ok' : 'error', output: stringOf(item, 'aggregated_output') };
        }
        case 'mcp_tool_call': {
            const error = jsonStringValue(item.error);
            if (error)
                return { status: 'error', output: error };
            const out = jsonStringValue(item.result) || jsonStringValue(item.output);
            return { status: itemStatus(item, out), output: out };
        }
        case 'web_search': {
            const out = webSearchSummary(item.results);
            return { status: itemStatus(item, out), output: out };
        }
        case 'file_change': {
            const out = fileChangeSummary(item);
            return { status: itemStatus(item, out), output: out };
        }
        default:
            return { status: 'error', output: jsonStringValue(item) };
    }
}

/** A bounded serialized file_change summary across the shapes Codex has emitted. */
function fileChangeSummary(item: Record<string, unknown>): string {
    for (const key of ['changes', 'change'] as const) {
        const value = jsonStringValue(item[key]);
        if (value && value !== 'null')
            return value;
    }
    return stringOf(item, 'path');
}

/** Maps the native item status to ok/error, defaulting to ok on nonempty output. */
function itemStatus(item: Record<string, unknown>, output: string): 'ok' | 'error' {
    const status = stringOf(item, 'status').toLowerCase().trim();
    if (['completed', 'complete', 'success', 'succeeded', 'done'].includes(status))
        return 'ok';
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status))
        return 'error';
    return output.trim() !== '' ? 'ok' : 'error';
}

/** Newline-joined web search result titles, bounded by the caller's truncation. */
function webSearchSummary(raw: unknown): string {
    if (!Array.isArray(raw) || raw.length === 0)
        return jsonStringValue(raw);
    return raw.map((entry) => {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            const title = stringOf(entry as Record<string, unknown>, 'title');
            if (title)
                return title;
        }
        return jsonStringValue(entry);
    }).join('\n');
}

/**
 * Builds the terminal turn usage record. A bridge-supplied tokenizer_v1 sample
 * set is forwarded unchanged, because those paired samples are the exact
 * evidence for that contract; they are never reconstructed from the whole-turn
 * timing. The turn duration is the client-reported end-to-end wall duration,
 * so it never becomes a speed denominator and the agent_turn_v1 contract is
 * claimed only for a positive duration with complete current-turn usage.
 */
function turnUsage(params: Record<string, unknown>): Record<string, unknown> | undefined {
    const usage = recordOf(params, 'usage');
    if (!usage && params.usage === undefined && params.duration_ms === undefined)
        return undefined;
    const source = usage ?? {};
    const input = nonnegativeInt(source.input_tokens);
    const output = nonnegativeInt(source.output_tokens);
    const durationMS = positiveInt(params.duration_ms);
    // Only genuinely captured counters are emitted. A partition the client
    // never reported stays absent rather than being fabricated as an
    // explicit zero, so a scope-less partial turn_usage record never claims
    // tokens that were never observed.
    const data: Record<string, unknown> = {};
    if (input !== undefined)
        data.input_tokens = input;
    if (output !== undefined)
        data.output_tokens = output;
    if (durationMS !== undefined)
        data.duration_ms = durationMS;
    const cached = nonnegativeInt(source.cached_input_tokens);
    if (cached !== undefined)
        data.cached_input_tokens = cached;
    const contract = stringOf(params, 'tps_sampling_contract').trim();
    const samples = params.tps_samples;
    if (contract && Array.isArray(samples) && samples.length > 0) {
        data.tps_sampling_contract = contract;
        data.tps_samples = samples;
    }
    if (durationMS !== undefined && completeUsageTokens({ input_tokens: input, output_tokens: output }))
        applyTrustedAgentTurnContract(data);
    return turnUsageRecord(data);
}
