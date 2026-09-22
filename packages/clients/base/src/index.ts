import { access, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
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
}
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
/**
 * A named bundle of agent behaviour the caller can attach to a launch. A
 * feature always contributes MCP servers (keyed by the name the client should
 * expose) and may carry free-form instructions that describe how the agent
 * should use them.
 */
export interface ExecutionFeature {
    readonly id: string;
    readonly instructions?: string;
    readonly mcpServers: Readonly<Record<string, McpServer>>;
}
export interface AgentRequest {
    readonly model: string;
    readonly canonicalModel?: string;
    readonly provider?: string;
    readonly mode?: 'native' | 'gateway';
    readonly protocol?: string;
    readonly prompt: string;
    readonly cwd: string;
    readonly resumeSessionId?: string;
    readonly thinking?: string;
    /** MCP servers to inject, keyed by the name exposed to the client. */
    readonly mcpServers?: Readonly<Record<string, McpServer>>;
}
export interface AgentResult {
    readonly exitCode: number | null;
}
export type AgentEvent = { readonly type: 'output'; readonly record: Record<string, unknown> } | { readonly type: 'stderr'; readonly text: string } | { readonly type: 'error'; readonly message: string } | { readonly type: 'exit'; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null };
export interface AgentSession {
    readonly events: AsyncIterable<AgentEvent>;
    readonly result: Promise<AgentResult>;
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
export interface AgentClient {
    readonly id: string;
    readonly capabilities: ClientCapabilities;
    inspect(options?: InspectOptions): Promise<ClientStatus>;
    start(request: AgentRequest, options?: OperationOptions): Promise<AgentSession>;
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
    constructor(readonly code: string, message = 'Client operation unavailable') { super(message); this.name = 'ClientError'; }
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
/** Shared PATH/explicit-path lookup. Client packages choose the executable names. */
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
