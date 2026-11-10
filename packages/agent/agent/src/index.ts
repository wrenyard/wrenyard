import { access, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { delimiter, isAbsolute, join } from 'node:path';
import type { ReasoningEffort } from '@wrenyard/models';
/** Stable agent protocol. No Forge process, profile command, or client switch. */
export interface ClientCapabilities {
    readonly run: boolean;
    readonly account: boolean;
    readonly resume: boolean;
}
export interface OperationOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly prepare?: (request: AgentRequest, env: NodeJS.ProcessEnv) => Promise<AgentClientPreparation | void>;
    readonly deferFinalize?: boolean;
    readonly onPrepared?: (env: NodeJS.ProcessEnv) => void;
    readonly onStreamClosed?: () => void;
}
export interface AgentFinalizeContext { readonly executionId?: string; readonly env: NodeJS.ProcessEnv }
export interface InspectOptions extends OperationOptions {
    readonly executable?: string;
    readonly refresh?: boolean;
}
export interface AccountOptions extends OperationOptions {
    readonly refresh?: boolean;
}
/**
 * A single MCP server the caller wants injected into a native client launch.
 * The transport is explicit and exhaustive: a stdio server is spawned from an
 * executable plus arguments; an HTTP server is reached at a URL. A client that
 * cannot faithfully represent a given transport must fail loudly rather than
 * silently dropping the server.
 */
export type McpServer = {
    readonly transport: 'stdio';
    readonly command: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly cwd?: string;
} | {
    readonly transport: 'http';
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
};
export interface AgentRequest {
    readonly model: string;
    readonly canonicalModel?: string;
    readonly provider?: string;
    readonly mode?: 'native' | 'gateway';
    readonly protocol?: string;
    readonly prompt: string;
    readonly cwd: string;
    readonly resumeSessionId?: string;
    /**
     * Execution id assigned by the execution layer. Set for supervised task
     * runs; adapters that need run-scoped state key it off this value rather
     * than a supervisor-injected environment variable.
     */
    readonly executionId?: string;
    /**
     * Public reasoning-effort level selected by the caller. Every run names an
     * exact level; `assertLaunch` rejects a missing or unknown value.
     */
    readonly reasoningEffort: ReasoningEffort;
    /** Optional Fast mode flag; native clients may apply a provider-verified fast variant. */
    readonly fast?: boolean;
    /**
     * Provider-mapped wire effort alias transported to the native runtime. It
     * is optional because a runtime that substitutes the upstream model instead
     * of a wire effort (Cursor) carries no alias, and a runtime that forwards
     * the public level (DSH) reads {@link reasoningEffort} directly.
     */
    readonly clientReasoningEffort?: string;
    readonly clientReasoningEnvironment?: Readonly<Record<string, string>>;
    /** MCP servers to inject, keyed by the name exposed to the client. */
    readonly mcpServers?: Readonly<Record<string, McpServer>>;
    /** Declared input modalities of the resolved model, when known. */
    readonly capabilities?: readonly ('text' | 'image')[];
}
export interface UpstreamError {
    readonly status?: number;
    readonly errorType?: string;
    readonly message?: string;
    readonly resetsAt?: string;
}
export type AgentEvent =
    | { readonly type: 'session'; readonly nativeSessionId: string; readonly profile?: string }
    | { readonly type: 'message'; readonly role: 'assistant'; readonly text: string }
    | { readonly type: 'reasoning'; readonly text: string }
    | { readonly type: 'tool_call'; readonly callId: string; readonly name: string; readonly inputSummary: string; readonly nativeSessionId?: string }
    | { readonly type: 'tool_result'; readonly callId: string; readonly status: 'ok' | 'error'; readonly outputTail: string; readonly nativeSessionId?: string }
    | ({ readonly type: 'usage' } & Readonly<Record<string, unknown>>)
    | ({ readonly type: 'finished'; readonly status: 'done' | 'failed'; readonly nativeSessionId?: string; readonly clientFamily?: string; readonly output?: string; readonly isError?: boolean; readonly error?: unknown; readonly failureClass?: string; readonly upstreamError?: UpstreamError; readonly recoveryAt?: string; readonly retryAfterSeconds?: number; readonly profile?: string } & Readonly<Record<string, unknown>>);
/** Decoder-only diagnostics and transport termination, removed by openSession. */
export type InternalAgentEvent =
    | { readonly type: 'stderr'; readonly text: string }
    | { readonly type: 'error'; readonly message: string }
    | { readonly type: 'exit'; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null };
export interface AgentSession {
    readonly events: AsyncIterable<AgentEvent>;
    cancel(): Promise<void>;
    readonly diagnostics: {
        readonly pid?: number;
    };
}
export type ClientStatus = {
    installation: { state: 'installed'; executable: string; version?: string } | { state: 'missing' } | { state: 'unknown'; reason: string };
    authentication: 'ready' | 'missing' | 'unknown';
};
export interface AccountSnapshot {
    readonly source?: string;
    readonly fetched_at?: string;
    readonly data?: unknown;
}
export type NativeModelAvailabilityStatus = 'available' | 'blocked' | 'unknown';
export type NativeModelAvailabilityReason = 'admin_blocked' | 'consent_required' | 'model_disabled' | 'unsupported';
export interface NativeModelAvailability {
    readonly status: NativeModelAvailabilityStatus;
    readonly reason?: NativeModelAvailabilityReason;
}
/**
 * Neutral, privacy-safe native login/model observation for one client. It
 * carries no token, path, stderr, or raw upstream payload: only the
 * authentication state and, for clients with a non-inference model probe, a
 * safe per-model status map. Absent model data never means available.
 */
export interface NativeClientReadiness {
    readonly authentication: 'ready' | 'missing' | 'unknown';
    readonly modelAvailability?: Readonly<Record<string, NativeModelAvailability>>;
}
export interface ReadinessOptions extends OperationOptions {
    /** Optional explicit home override, mirroring client native credential paths. */
    readonly home?: string;
}
/**
 * Client-side launch preparation returned by {@link AgentClient.prepare}. The
 * `env` entries are merged over the caller-supplied operation env before
 * `start`, composing with any env the operation-component preparation
 * (browser env modifiers, desktop lane release ordering, core.mts exec.start
 * reuse) already produced — the client never replaces that env wholesale.
 */
export interface AgentClientPreparation {
    readonly env?: NodeJS.ProcessEnv;
    readonly prompt?: string;
    readonly mcpServers?: Readonly<Record<string, McpServer>>;
    readonly release?: () => Promise<void>;
}
export interface AgentClient {
    readonly id: string;
    readonly capabilities: ClientCapabilities;
    inspect(options?: InspectOptions): Promise<ClientStatus>;
    /**
     * Optional pre-start hook: runs before {@link start} with the fully
     * resolved request (including `executionId`) and the composed operation
     * env available, so the adapter can contribute run-scoped env or bind
     * per-execution state. Clients that do not implement it are unaffected.
     */
    prepare?(request: AgentRequest, options?: OperationOptions): Promise<AgentClientPreparation | void>;
    start(request: AgentRequest, options?: OperationOptions): Promise<AgentSession>;
    /**
     * Optional post-run hook: runs after the run's committed terminal status
     * is known. Cancel/timeout/shutdown intent precedence is already resolved
     * by the execution supervisor, so `status` is the durable outcome; the
     * adapter uses it for its own session-snapshot retention/cleanup.
     */
    finalize?(status: string, context: AgentFinalizeContext): Promise<void>;
    readAccount?(options?: AccountOptions): Promise<AccountSnapshot>;
    /**
     * Optional non-inference native auth/model observation. Cheap and separate
     * from `inspect` (installation only); callers must treat a rejected or
     * unavailable observation as unknown, never as ready.
     */
    readReadiness?(options?: ReadinessOptions): Promise<NativeClientReadiness>;
}
export interface StreamChunk {
    readonly type: string;
    readonly data?: Uint8Array;
    readonly exitCode?: number | null;
    readonly signal?: NodeJS.Signals | null;
    readonly message?: string;
}
export class ClientError extends Error {
    constructor(readonly code: string, message = 'Client operation unavailable', readonly retryAfterMs?: number) { super(message); this.name = 'ClientError'; }
}
/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
    if (value === null)
        return undefined;
    const text = value.trim();
    if (/^\d+$/.test(text))
        return Number(text) * 1000;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? Math.max(0, parsed - now) : undefined;
}
export function observation(source: string, data: unknown): AccountSnapshot {
    return { source, fetched_at: new Date().toISOString(), data };
}
export async function requestJson(url: string, init: RequestInit, options?: OperationOptions): Promise<unknown> {
    const timeout = AbortSignal.timeout(Math.min(options?.timeoutMs ?? 10000, 10000));
    const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await fetch(url, { ...init, signal, redirect: 'error' });
    if (!response.ok) {
        await response.body?.cancel();
        // A 429 is a temporary upstream limit, not a query failure: surface the
        // Retry-After so callers can back off instead of retrying immediately.
        if (response.status === 429)
            throw new ClientError('rate_limited', 'Upstream rate limited', parseRetryAfterMs(response.headers.get('retry-after')));
        throw new ClientError(response.status === 401 || response.status === 403 ? 'authentication_required' : 'quota_query_failed');
    }
    if (!response.body)
        throw new ClientError('empty_response');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > 1024 * 1024) {
                await reader.cancel();
                throw new ClientError('response_too_large');
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** Find an installed executable and report its version. */
export async function withVersion(status: ClientStatus, options?: InspectOptions): Promise<ClientStatus> {
    if (status.installation.state !== 'installed')
        return status;
    const executable = status.installation.executable;
    const env = options?.env ?? process.env;
    const version = await new Promise<string | undefined>((resolve) => {
        let output = '';
        let errorOutput = '';
        let settled = false;
        const finish = (value: string | undefined): void => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(executable, ['--version'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch {
            resolve(undefined);
            return;
        }
        const timer = setTimeout(() => {
            child.kill();
            finish(undefined);
        }, 5_000);
        child.stdout?.on('data', (chunk: Buffer) => {
            if (output.length < 4_096)
                output += chunk.toString('utf8').slice(0, 4_096 - output.length);
        });
        // Some clients (e.g. Pi) print their version on stderr; stdout wins when both do.
        child.stderr?.on('data', (chunk: Buffer) => {
            if (errorOutput.length < 4_096)
                errorOutput += chunk.toString('utf8').slice(0, 4_096 - errorOutput.length);
        });
        child.on('error', () => finish(undefined));
        child.on('close', (code) => {
            const pattern = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;
            const match = pattern.exec(output) ?? pattern.exec(errorOutput);
            finish(code === 0 ? match?.[0] : undefined);
        });
    });
    return version ? { ...status, installation: { ...status.installation, version } } : status;
}

/** Locate a client executable from configuration or PATH. */
export async function findExecutable(names: readonly string[], options?: InspectOptions): Promise<ClientStatus> {
    const env = options?.env ?? process.env;
    const explicit = options?.executable?.trim();
    if (explicit) {
        if (!isAbsolute(explicit)) {
            return { installation: { state: 'unknown', reason: 'configured executable is not absolute' }, authentication: 'unknown' };
        }
        const resolved = await resolveFile(explicit);
        if (resolved === 'unreadable')
            return { installation: { state: 'unknown', reason: 'configured executable is not readable' }, authentication: 'unknown' };
        return resolved
            ? { installation: { state: 'installed', executable: resolved }, authentication: 'unknown' }
            : { installation: { state: 'unknown', reason: 'configured executable is unavailable' }, authentication: 'unknown' };
    }
    const pathKey = process.platform === 'win32'
        ? Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path'
        : 'PATH';
    for (const directory of (env[pathKey] ?? '').split(delimiter).filter(Boolean)) {
        for (const name of names) {
            const candidates = process.platform === 'win32'
                ? [join(directory, `${name}.cmd`), join(directory, `${name}.exe`), join(directory, name)]
                : [join(directory, name)];
            for (const candidate of candidates) {
                const resolved = await resolveFile(candidate);
                if (resolved === 'unreadable')
                    return { installation: { state: 'unknown', reason: 'executable is not readable' }, authentication: 'unknown' };
                if (resolved)
                    return { installation: { state: 'installed', executable: resolved }, authentication: 'unknown' };
            }
        }
    }
    return { installation: { state: 'missing' }, authentication: 'unknown' };
}
async function resolveFile(path: string): Promise<string | 'unreadable' | undefined> {
    try {
        await access(path);
    }
    catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM')
            return 'unreadable';
        return undefined;
    }
    try {
        return await realpath(path);
    }
    catch {
        return isAbsolute(path) ? path : undefined;
    }
}
