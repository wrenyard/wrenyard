import { setTimeout as delay } from 'node:timers/promises';
import { startAcpTransport, type AcpMcpServer, type AcpPromptResult, type AcpTransport } from '@wrenyard/execution';
import type { AgentEvent, AgentRequest, AgentSession, OperationOptions } from '@wrenyard/agent-client';
import { enrichFinishedEvent, jsonStringValue, reasoningRecord, runFinishedRecord, sessionEvent, toolCallRecord, toolResultRecord, truncateTail, turnUsageRecord } from '@wrenyard/agent-client/native';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { KimiLaunch } from './launch.ts';

/** Input summary ceiling for tool_call records. */
const INPUT_SUMMARY_MAX_CHARS = 200;
/**
 * Bounded window for a cancelled turn to settle through session/cancel before
 * the connection is closed; matches the process-tree termination fallback the
 * execution session applies around killProcessTree.
 */
const CANCEL_SETTLE_MS = 5_000;

interface TurnState {
    sessionId: string | undefined;
    output: string;
    sessionEmitted: boolean;
    /** Typed usage record produced by the settled prompt, drained before finished. */
    usage?: AgentEvent;
    /** The terminal AgentEvent once the prompt outcome is known. */
    done: boolean;
    /**
     * Set when the caller initiated termination via cancel() or an aborted
     * options.signal. A terminal outcome whose proximate cause is that cancel —
     * including bounded-fallback/transport errors teardown itself raised — is
     * classified cancelled, never failed. Genuine provider/spawn failures while
     * no cancel was initiated keep their real classification.
     */
    callerCancelled: boolean;
}

/**
 * Drive one `kimi acp` run through the shared ACP transport and expose it as
 * an AgentSession: initialize, session/new or session/resume, yolo mode, the
 * requested model via session/set_config_option, then a single text prompt.
 * A resume failure surfaces as the run's failed finished record — it never
 * falls back to session/new.
 */
export async function startKimiAcpSession(request: AgentRequest, launch: KimiLaunch, options?: OperationOptions): Promise<AgentSession> {
    const transport = await startAcpTransport(launch.spec, { name: 'wrenyard-kimi' });
    const state: TurnState = { sessionId: undefined, output: '', sessionEmitted: false, done: false, callerCancelled: false };
    const terminal = deferred<AgentEvent>();
    // Filled in once the signal listener below is registered; the events
    // generator calls it on every terminal/cleanup path. Removing an
    // already-fired once-listener is harmless.
    let removeAbortListener = (): void => {};
    const session: AgentSession = {
        events: runEvents(transport, launch, request, state, terminal, () => removeAbortListener()),
        cancel: async () => {
            // Record caller intent first: any terminal outcome from here on is
            // attributed to this cancellation, including errors the bounded
            // fallback teardown raises because of it.
            state.callerCancelled = true;
            // session/cancel goes first so the agent stops the turn, then a
            // bounded wait gives the prompt request a window to resolve with
            // stopReason 'cancelled'; teardown never depends on one more
            // notification arriving. The run home is released inside
            // transport.close(), only after the owned tree is confirmed gone.
            if (state.sessionId && !state.done)
                await transport.cancel(state.sessionId).catch(() => undefined);
            if (!terminal.settled)
                await Promise.race([terminal.promise, delay(CANCEL_SETTLE_MS)]);
            await transport.close();
        },
        diagnostics: transport.diagnostics,
    };
    if (options?.signal?.aborted) {
        await session.cancel();
    } else if (options?.signal) {
        const signal = options.signal;
        const onAbort = () => { void session.cancel(); };
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }
    return session;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    const box = {
        promise,
        settled: false,
        set(value: T) { if (!box.settled) { box.settled = true; resolve(value); } },
    };
    return box;
}

async function* runEvents(
    transport: AcpTransport,
    launch: KimiLaunch,
    request: AgentRequest,
    state: TurnState,
    terminal: ReturnType<typeof deferred<AgentEvent>>,
    onTerminal: () => void,
): AsyncGenerator<AgentEvent> {
    // Updates and prompt completion are consumed concurrently through one
    // merged stream so permission requests can never deadlock against an
    // un-consumed notification queue, and the terminal outcome never waits on
    // a further notification or on process exit.
    const merged = mergeUpdatesAndCompletion(transport, launch, request, state);
    const sessionPending = (): AgentEvent | undefined => {
        if (state.sessionEmitted || !state.sessionId) return undefined;
        state.sessionEmitted = true;
        return sessionEvent(state.sessionId);
    };
    try {
        for await (const item of merged) {
            const session = sessionPending();
            if (session) yield session;
            if (item.kind === 'notification') {
                const event = mapUpdate(item.notification, state);
                if (event) yield event;
                continue;
            }
            if (state.usage) yield state.usage;
            terminal.set(item.event);
            yield item.event;
            return;
        }
        // The update stream ended without a completion: the connection or the
        // process went away before the prompt resolved.
        const session = sessionPending();
        if (session) yield session;
        const event = await merged.event();
        if (state.usage) yield state.usage;
        terminal.set(event);
        yield event;
    } catch (error) {
        // A caller-initiated cancel closes the connection underneath the run;
        // the resulting teardown/stream error is the cancellation's own side
        // effect and surfaces as cancelled, not failed. With no cancel in
        // flight the error keeps its real provider/transport classification.
        const event = state.callerCancelled
            ? finishedForStopReason('cancelled', state.sessionId, state.output)
            : failedFromStderr(launch, transport, error instanceof Error ? error.message : String(error), state.sessionId);
        if (state.usage) yield state.usage;
        terminal.set(event);
        yield event;
    } finally {
        state.done = true;
        // Detach the signal abort listener on every exit path — normal,
        // error, and cancel-settle alike — so a long-lived caller signal
        // does not retain this run.
        onTerminal();
        // transport.close() applies the owned teardown contract — files rolled
        // back, marker finalized, home removed only after the process tree was
        // confirmed gone. A close failure means teardown is unproven: the home
        // is preserved and the failure is surfaced, never papered over by an
        // unverified rm.
        try {
            await transport.close();
        } catch (error) {
            console.error('kimi acp teardown failed; run home preserved:', error);
        }
    }
}

type MergedItem =
    | { readonly kind: 'notification'; readonly notification: SessionNotification }
    | { readonly kind: 'completion'; readonly event: AgentEvent };

/**
 * Merge the transport's update notifications with the ordered request
 * sequence's completion into one async iterable. Notifications yield in
 * arrival order; the completion yields exactly once, after every notification
 * queued before it and even when no further notification ever arrives; the
 * iterator ends on whichever is exhausted, so a prompt that settles while the
 * queue is empty is picked up without waiting on the persistent server.
 */
function mergeUpdatesAndCompletion(
    transport: AcpTransport,
    launch: KimiLaunch,
    request: AgentRequest,
    state: TurnState,
): AsyncIterable<MergedItem> & { event(): Promise<AgentEvent> } {
    const updates = transport.updates[Symbol.asyncIterator]();
    const finished = consume(transport, launch, request, state);
    return {
        event: () => finished.event(),
        async *[Symbol.asyncIterator]() {
            const nextNotification = (): Promise<{ notification?: SessionNotification; error?: unknown }> =>
                updates.next().then(
                    (result) => (result.done ? {} : { notification: result.value }),
                    (error: unknown) => ({ error }),
                );
            let pending = nextNotification();
            // The completion promise is created once; each loop iteration
            // races one pending update against it, so a prompt that settles
            // while the queue is empty is picked up without waiting on one
            // more notification.
            const completion = finished.event();
            // Sentinel for the non-blocking drain below: an already-resolved
            // promise loses Promise.race against a `pending` that resolved
            // earlier, so only a still-pending update reaches the sentinel.
            const sentinel = Promise.resolve({ drained: true });
            const drainQueued = async function* (): AsyncGenerator<MergedItem> {
                while (true) {
                    const next = await Promise.race([pending, sentinel]);
                    if ('drained' in next) return;
                    if (next.notification !== undefined) {
                        yield { kind: 'notification', notification: next.notification };
                        pending = nextNotification();
                        continue;
                    }
                    if (next.error !== undefined)
                        throw next.error;
                    return;
                }
            };
            while (true) {
                const raced = await Promise.race([
                    pending,
                    completion.then((): { completion: true } => ({ completion: true })),
                ]);
                if ('completion' in raced) {
                    // The prompt settled while updates were still queued:
                    // drain whatever is already in the queue (non-blocking —
                    // do not wait for new arrivals) and yield it before the
                    // completion so the finished event, built lazily inside
                    // finished.event(), sees the full output and tool events.
                    yield* drainQueued();
                    yield { kind: 'completion', event: await finished.event() };
                    return;
                }
                if (raced.notification !== undefined) {
                    yield { kind: 'notification', notification: raced.notification };
                    pending = nextNotification();
                    continue;
                }
                if (raced.error !== undefined)
                    throw raced.error;
                // The notification stream is over: the completion, already
                // resolved or still pending, is the last item this run can
                // produce.
                yield { kind: 'completion', event: await completion };
                return;
            }
        },
    };
}

/** The ordered ACP request sequence, resolved once into the terminal event. */
function consume(transport: AcpTransport, launch: KimiLaunch, request: AgentRequest, state: TurnState) {
    const promise = (async (): Promise<() => AgentEvent> => {
        try {
            await transport.initialize({ name: 'wrenyard', title: 'Wrenyard', version: '1' });
            const mcpServers = toAcpServers(launch.mcpServers);
            if (request.resumeSessionId) {
                await transport.resumeSession({
                    sessionId: request.resumeSessionId,
                    cwd: request.cwd,
                    ...(mcpServers ? { mcpServers } : {}),
                });
                state.sessionId = request.resumeSessionId;
            } else {
                const created = await transport.newSession({ cwd: request.cwd, mcpServers: mcpServers ?? [] });
                state.sessionId = created.sessionId;
            }
            launch.captured.sessionId ??= state.sessionId;
            const sessionId = state.sessionId!;
            await transport.setMode(sessionId, 'yolo');
            if (request.model.trim())
                await transport.setConfigOption(sessionId, 'model', request.model.trim());
            const result = await transport.prompt(sessionId, request.prompt);
            emitUsage(result, state);
            // Built lazily by event(): updates already queued when the prompt
            // resolved are drained first, so the terminal event sees the full
            // output and tool events they carried.
            return () => finishedForStopReason(result.stopReason, sessionId, state.output);
        } catch (error) {
            // A failure produced while a caller-initiated cancel is in flight
            // — a prompt rejected because our own session/cancel or connection
            // teardown interrupted it, including during setup — is the cancel's
            // side effect and surfaces as cancelled. A failure produced before
            // any cancel keeps its real provider/transport classification even
            // if the caller cancels while the event is still draining.
            if (state.callerCancelled)
                return () => finishedForStopReason('cancelled', state.sessionId, state.output);
            return () => failedFromStderr(launch, transport, error instanceof Error ? error.message : String(error), state.sessionId);
        }
    })();
    // The terminal outcome is always a finished event, never a rejection:
    // cancel() may await it after teardown began.
    promise.catch(() => undefined);
    return {
        async event() { return enrichFinishedEvent((await promise)(), transport.stderrTail); },
    };
}

/**
 * Map an ACP prompt `usage` payload onto the shared typed usage event when the
 * agent reports one. `usage` is an unstable, optional PromptResponse field;
 * whether `kimi acp` actually populates it is unverified — the mapping is
 * wired for whenever it is present.
 */
function emitUsage(result: AcpPromptResult, state: TurnState): void {
    const usage = result.usage;
    if (!usage || state.usage) return;
    state.usage = turnUsageRecord({
        total_tokens: usage.totalTokens,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        ...(typeof usage.thoughtTokens === 'number' ? { reasoning_output_tokens: usage.thoughtTokens } : {}),
        ...(typeof usage.cachedReadTokens === 'number' ? { cache_read_input_tokens: usage.cachedReadTokens } : {}),
        ...(typeof usage.cachedWriteTokens === 'number' ? { cache_creation_input_tokens: usage.cachedWriteTokens } : {}),
    });
}

function toAcpServers(servers: KimiLaunch['mcpServers']): AcpMcpServer[] | undefined {
    if (servers.length === 0) return undefined;
    return servers.map(({ name, server }) => {
        if (server.transport === 'http')
            return { transport: 'http', name, url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
        return { transport: 'stdio', name, command: server.command, ...(server.args ? { args: server.args } : {}), ...(server.env ? { env: server.env } : {}) };
    });
}

/** Map one session/update notification to the common AgentEvent surface. */
function mapUpdate(notification: SessionNotification, state: TurnState): AgentEvent | undefined {
    const update = notification.update;
    switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
            const text = update.content.type === 'text' ? update.content.text : '';
            if (!text) return undefined;
            state.output += text;
            return { type: 'message', role: 'assistant', text };
        }
        case 'agent_thought_chunk': {
            const text = update.content.type === 'text' ? update.content.text : '';
            return text ? reasoningRecord(text) : undefined;
        }
        case 'tool_call': {
            const name = update.name ?? update.kind ?? update.title ?? 'unknown';
            const input = update.title || jsonStringValue(update.rawInput);
            return toolCallRecord(name, update.toolCallId, input.slice(0, INPUT_SUMMARY_MAX_CHARS));
        }
        case 'tool_call_update': {
            if (update.status !== 'completed' && update.status !== 'failed') return undefined;
            return toolResultRecord(
                update.toolCallId,
                update.status === 'completed' ? 'ok' : 'error',
                truncateTail(toolCallContentText(update.content ?? [])),
            );
        }
        // usage_update is context-window-only; notice, plan,
        // available_commands_update, current_mode_update, config_option_update,
        // session_info_update and unknown variants carry no turn state.
        default:
            return undefined;
    }
}

/** Flattened text content of a tool call's content blocks. */
function toolCallContentText(content: readonly unknown[]): string {
    const parts: string[] = [];
    for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const entry = item as { type?: string; content?: { type?: string; text?: unknown }; newText?: unknown; path?: unknown };
        if (entry.type === 'content' && entry.content?.type === 'text' && typeof entry.content.text === 'string')
            parts.push(entry.content.text);
        else if (entry.type === 'diff' && typeof entry.newText === 'string')
            parts.push(entry.newText);
    }
    return parts.join('\n');
}

/** stopReason → terminal event, mirroring the retired stdio decoder semantics. */
function finishedForStopReason(stopReason: string, sessionId: string | undefined, output: string): AgentEvent {
    switch (stopReason) {
        case 'end_turn':
            return runFinishedRecord('kimi', 'done', sessionId, { is_error: false, ...(output ? { output } : {}) });
        case 'max_tokens':
            return runFinishedRecord('kimi', 'done', sessionId, { is_error: false, ...(output ? { output } : {}), stop_reason: 'max_tokens' });
        case 'max_turn_requests':
            return runFinishedRecord('kimi', 'failed', sessionId, { is_error: true, error: 'agent reached max turn requests' });
        case 'refusal':
            return runFinishedRecord('kimi', 'failed', sessionId, { is_error: true, error: 'agent refused the request' });
        case 'cancelled':
            return runFinishedRecord('kimi', 'done', sessionId, { is_error: false, ...(output ? { output } : {}), stop_reason: 'cancelled' });
        default:
            return runFinishedRecord('kimi', 'failed', sessionId, { is_error: true, error: `agent stopped with unknown reason ${stopReason}` });
    }
}

/** Cancelled terminal event, mirroring the 'cancelled' stopReason mapping. */
/**
 * Failure payload classified the way the retired wire decoder did: a 429 /
 * exceeded_current_quota_error is quota_exhausted (with recovery_at when a
 * retry-after is visible) and a 401 / provider.auth_error is auth_failed.
 */
function failedFromStderr(launch: KimiLaunch, transport: AcpTransport, fallback: string, sessionId?: string): AgentEvent {
    const stderr = transport.stderrTail;
    const firstLine = stderr.split(/\r?\n/, 1)[0]?.trim() ?? '';
    const parsed = /^error: failed to run prompt: ([^:]+): (.+)$/u.exec(firstLine);
    const code = parsed?.[1]?.trim() ?? '';
    const statusMatch = /\b(4\d{2}|5\d{2})\b/u.exec(stderr);
    const status = statusMatch ? Number(statusMatch[1]) : undefined;
    const quotaExhausted = (status === 429 && code.includes('quota')) || code === 'exceeded_current_quota_error';
    const authFailed = status === 401 || code === 'provider.auth_error';
    const message = parsed?.[2]?.trim() || firstLine || fallback;
    const error: Record<string, unknown> = { message };
    if (status !== undefined) error.status = status;
    if (code) error.type = code;
    return runFinishedRecord('kimi', 'failed', sessionId ?? launch.captured.sessionId, {
        is_error: true,
        error,
        ...(quotaExhausted ? { failure_class: 'quota_exhausted' } : {}),
        ...(authFailed && !quotaExhausted ? { failure_class: 'auth_failed' } : {}),
    });
}
