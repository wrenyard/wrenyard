import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { killProcessTree, spawnProcess } from './process.ts';
import {
    cleanupFiles,
    cleanupOwnedRunHome,
    markOwnedRunPhase,
    materializeFiles,
    unixProcessGroupIsGone,
    withTimeoutResolved,
    type ProcessFile,
    type ProcessSpec,
} from './session.ts';

/** Retained stderr diagnostics tail; never emitted as a consumer event. */
const STDERR_TAIL_BYTES = 16 * 1024;
/** Finite fallback when killProcessTree cannot confirm tree termination. */
const TERMINATION_FALLBACK_MS = 5_000;
/** Finite confirmation window for the child process being spawned. */
const STARTUP_CONFIRM_MS = 15_000;

export interface AcpTransportSpec {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    /** Files materialized into place before the agent process is spawned. */
    readonly files?: readonly ProcessFile[];
    /** Wrenyard-owned run home; same lifecycle contract as ProcessSpec. */
    readonly ownedRunHome?: ProcessSpec['ownedRunHome'];
}

export interface AcpTransportOptions {
    /** Human-readable connection name for JSON-RPC diagnostics. */
    readonly name?: string;
}

/** MCP server definition accepted by the transport; converted to ACP shape. */
export type AcpMcpServer =
    | { readonly transport: 'stdio'; readonly name: string; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
    | { readonly transport: 'http'; readonly name: string; readonly url: string; readonly headers?: Readonly<Record<string, string>> };

export interface AcpNewSessionRequest {
    readonly cwd: string;
    readonly mcpServers: readonly AcpMcpServer[];
}

export interface AcpResumeSessionRequest {
    readonly sessionId: string;
    readonly cwd: string;
    readonly mcpServers?: readonly AcpMcpServer[];
}

export interface AcpPromptResult {
    readonly stopReason: acp.StopReason;
    readonly usage?: acp.Usage | null;
}

export interface AcpTransport {
    initialize(clientInfo: acp.Implementation): Promise<acp.InitializeResponse>;
    newSession(request: AcpNewSessionRequest): Promise<acp.NewSessionResponse>;
    resumeSession(request: AcpResumeSessionRequest): Promise<acp.ResumeSessionResponse>;
    setConfigOption(sessionId: string, configId: string, value: string): Promise<acp.SetSessionConfigOptionResponse>;
    setMode(sessionId: string, modeId: string): Promise<acp.SetSessionModeResponse>;
    prompt(sessionId: string, promptText: string): Promise<AcpPromptResult>;
    cancel(sessionId: string): Promise<void>;
    /** Every session/update notification, in arrival order; ends on close. */
    readonly updates: AsyncIterable<acp.SessionNotification>;
    /** Close the streams, then terminate the agent's process tree. */
    close(): Promise<void>;
    readonly diagnostics: { pid?: number };
    /** Bounded tail of the agent's stderr diagnostics. */
    readonly stderrTail: string;
}

/**
 * Spawn an ACP agent process and drive it over newline-delimited JSON-RPC
 * stdio using the official SDK. The transport owns the child process for its
 * whole lifetime: `close()` shuts the streams and kills the process tree, and
 * a process exit or connection close terminates `updates` and rejects every
 * pending request so no caller can hang.
 *
 * Permission requests are answered without a user: `allow_always` when the
 * agent offers it, else `allow_once`, else the first option; a request with no
 * options is cancelled.
 */
export async function startAcpTransport(spec: AcpTransportSpec, options: AcpTransportOptions = {}): Promise<AcpTransport> {
    // Same pre-spawn contract as startProcess: materialize owned files into the
    // run home, then record `spawning` on the owned marker so a crash between
    // here and the spawn leaves the protected ambiguous window on disk.
    const resources = await materializeFiles(spec.files ?? []).catch(async (error) => {
        await cleanupOwnedRunHome(spec.ownedRunHome, false, true).catch(() => undefined);
        throw error;
    });
    try { await markOwnedRunPhase(spec.ownedRunHome, { launch_phase: 'spawning' }); }
    catch (error) {
        await cleanupFiles(resources, false, true).catch(() => undefined);
        await cleanupOwnedRunHome(spec.ownedRunHome, false, true).catch(() => undefined);
        throw error;
    }
    let child: ChildProcess;
    try {
        child = spawnProcess(spec.executable, spec.args, {
            env: spec.env,
            cwd: spec.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
        });
    } catch (error) {
        await cleanupFiles(resources, false, true).catch(() => undefined);
        await cleanupOwnedRunHome(spec.ownedRunHome, false, true).catch(() => undefined);
        throw error;
    }
    if (!child.stdin || !child.stdout) {
        await cleanupFiles(resources, false, true).catch(() => undefined);
        await cleanupOwnedRunHome(spec.ownedRunHome, false, true).catch(() => undefined);
        throw new Error('ACP agent process could not provide stdio pipes');
    }

    const stderrTail = new TextTail(STDERR_TAIL_BYTES);
    child.stderr?.on('data', (chunk: Buffer) => { stderrTail.push(chunk.toString('utf8')); });
    child.stderr?.on('error', () => { /* drained and discarded */ });

    const updates = createQueue<acp.SessionNotification>();
    let ended = false;
    let spawnError: Error | undefined;
    const startupTimer = setTimeout(() => {
        end(new Error('ACP agent process did not start'));
    }, STARTUP_CONFIRM_MS);
    const startup = new Promise<number | undefined>((resolve, reject) => {
        child.once('spawn', () => resolve(child.pid));
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            reject(new Error(`ACP agent exited before initialization (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`));
        });
    });

    function end(cause?: unknown): void {
        if (ended) return;
        ended = true;
        clearTimeout(startupTimer);
        updates.close(cause instanceof Error ? cause : undefined);
    }

    // Node child stdin is the agent's input (our output); stdout is our input.
    // toWeb() returns node:stream/web classes; the ACP SDK expects the ambient
    // DOM stream types, which are structurally incompatible in @types/node
    // though identical at runtime (Node >= 24 ships the same classes).
    const outputStream = Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>;
    const inputStream = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(outputStream, inputStream);

    const app = acp.client({ name: options.name ?? 'wrenyard' });
    app.onNotification('session/update', (context) => { updates.push(context.params); });
    app.onRequest('session/request_permission', (context): acp.RequestPermissionResponse => {
        const choices = context.params.options ?? [];
        const preferred = choices.find((option) => option.kind === 'allow_always')
            ?? choices.find((option) => option.kind === 'allow_once')
            ?? choices[0];
        if (preferred === undefined)
            return { outcome: { outcome: 'cancelled' } };
        return { outcome: { outcome: 'selected', optionId: preferred.optionId } };
    });
    const connection = app.connect(stream);
    void connection.closed.then(() => { end(new Error('ACP connection closed')); });
    child.once('exit', () => { end(new Error('ACP agent process exited')); });
    child.once('error', (error: Error) => { spawnError = error; end(error); });

    const pid = await startup.catch(async (error) => {
        let proven = false;
        try {
            await cleanup();
            proven = process.platform === 'win32'
                || child.pid === undefined
                || unixProcessGroupIsGone(child.pid);
        }
        catch { /* unconfirmed termination retains the home for recovery */ }
        if (proven)
            await releaseHome(false).catch(() => undefined);
        else
            console.error('ACP agent teardown unproven; owned run home preserved for recovery');
        end(error);
        throw error;
    });
    clearTimeout(startupTimer);

    // Record the spawned child identity on the owned marker, matching the
    // startProcess provenance contract. A child that cannot be described on
    // disk must not run untracked: its tree is terminated, and when that
    // termination cannot be confirmed the home is retained for recovery.
    if (spec.ownedRunHome && pid !== undefined) {
        try {
            await markOwnedRunPhase(spec.ownedRunHome, {
                launch_phase: 'running',
                child_pid: pid,
                // A Unix child is spawned detached, so pgid === pid; Windows
                // cannot express that identity and is left without it.
                ...(process.platform === 'win32' ? {} : { child_pgid: pid }),
            });
        } catch (error) {
            let proven = false;
            try {
                await cleanup();
                // killProcessTree already waited for group exit and
                // connection.close() is inert for a child that never spawned,
                // so cleanup() resolving means no live tree can still hold
                // the home; where a group can be expressed, confirm it is
                // gone outright before releasing.
                proven = process.platform === 'win32'
                    || child.pid === undefined
                    || unixProcessGroupIsGone(child.pid);
            }
            catch { /* unconfirmed termination retains the home for recovery */ }
            if (proven)
                await releaseHome(false).catch(() => undefined);
            else
                console.error('ACP agent teardown unproven; owned run home preserved for recovery');
            end(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    const diagnostics: { pid?: number } = {};
    if (pid !== undefined) diagnostics.pid = pid;

    /**
     * Ordered owned-resource release, mirroring startProcess's settle: owned
     * files roll back/clean up after the process is down, and the owned run
     * home is removed only once the child tree is confirmed terminated —
     * never while a surviving group member could still write into it.
     */
    async function releaseHome(success: boolean): Promise<void> {
        await cleanupFiles(resources, success).catch(() => undefined);
        await cleanupOwnedRunHome(spec.ownedRunHome, success);
    }

    let closing: Promise<void> | undefined;
    async function cleanup(): Promise<void> {
        try { connection.close(spawnError); } catch { /* already closed */ }
        if (child.pid !== undefined) {
            await withTimeoutResolved(
                killProcessTree(child.pid),
                TERMINATION_FALLBACK_MS,
                `process tree ${child.pid} was not confirmed terminated`,
            );
            // The child is detached on Unix, so its pid is its group id; a
            // surviving member keeps the run home unclaimed.
            if (spec.ownedRunHome !== undefined && process.platform !== 'win32'
                && !unixProcessGroupIsGone(child.pid))
                throw new Error(`process group ${child.pid} was not confirmed stopped`);
        }
    }

    const transport: AcpTransport = {
        updates,
        diagnostics,
        get stderrTail() { return stderrTail.toString(); },
        initialize: (clientInfo) => connection.agent.request('initialize', {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientInfo,
        }),
        newSession: (request) => connection.agent.request('session/new', {
            cwd: request.cwd,
            mcpServers: request.mcpServers.map(toAcpMcpServer),
        }),
        resumeSession: (request) => connection.agent.request('session/resume', {
            sessionId: request.sessionId,
            cwd: request.cwd,
            ...(request.mcpServers ? { mcpServers: request.mcpServers.map(toAcpMcpServer) } : {}),
        }),
        setConfigOption: (sessionId, configId, value) => connection.agent.request('session/set_config_option', { sessionId, configId, value }),
        setMode: (sessionId, modeId) => connection.agent.request('session/set_mode', { sessionId, modeId }),
        prompt: async (sessionId, promptText) => {
            const response = await connection.agent.request('session/prompt', {
                sessionId,
                prompt: [{ type: 'text', text: promptText }],
            });
            return { stopReason: response.stopReason, usage: response.usage };
        },
        cancel: (sessionId) => connection.agent.notify('session/cancel', { sessionId }),
        close: () => {
            closing ??= (async () => {
                end();
                // Run-home deletion waits on confirmed tree termination; a
                // close that cannot prove the child is gone rejects rather
                // than silently removing a home a live process still owns.
                await cleanup();
                await releaseHome(true);
            })();
            closing.catch(() => undefined);
            return closing;
        },
    };
    return transport;
}

function toAcpMcpServer(server: AcpMcpServer): acp.McpServer {
    if (server.transport === 'http') {
        return {
            type: 'http',
            name: server.name,
            url: server.url,
            headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
        };
    }
    return {
        name: server.name,
        command: server.command,
        args: [...(server.args ?? [])],
        env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
    };
}

/** Bounded string tail keeping only the most recent characters. */
class TextTail {
    private text = '';
    constructor(private readonly maxChars: number) {}
    push(chunk: string): void {
        this.text = (this.text + chunk).slice(-this.maxChars);
    }
    toString(): string { return this.text; }
}

/**
 * Multi-consumer async queue. `push` drops nothing; `close` ends every
 * consumer, and `close(error)` rejects their pending `next()` so a transport
 * failure can never leave a consumer suspended.
 */
function createQueue<T>(): AsyncIterable<T> & { push(value: T): void; close(error?: Error): void } {
    const items: T[] = [];
    const waiters: Array<{ resolve(result: IteratorResult<T>): void; reject(error: Error): void }> = [];
    let closed = false;
    let failure: Error | undefined;
    return {
        push(value: T) {
            if (closed) return;
            const waiter = waiters.shift();
            if (waiter) waiter.resolve({ value, done: false });
            else items.push(value);
        },
        close(error?: Error) {
            if (closed) return;
            closed = true;
            failure = error;
            for (const waiter of waiters.splice(0)) {
                if (failure) waiter.reject(failure);
                else waiter.resolve({ value: undefined as T, done: true });
            }
        },
        async *[Symbol.asyncIterator]() {
            while (true) {
                if (items.length > 0) {
                    yield items.shift() as T;
                    continue;
                }
                if (closed) {
                    if (failure) throw failure;
                    return;
                }
                const next = await new Promise<IteratorResult<T>>((resolve, reject) => { waiters.push({ resolve, reject }); });
                if (next.done) return;
                yield next.value;
            }
        },
    };
}
