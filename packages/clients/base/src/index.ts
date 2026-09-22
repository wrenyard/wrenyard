import { isAbsolute } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { ForgeExecutor, type ForgeExecutionOptions, type ExecutionResult } from '@wrenyard/execution';
export type ClientOptions = Pick<ForgeExecutionOptions, 'env' | 'cwd' | 'signal' | 'timeoutMs'>;
export interface AgentRun {
    profile: string;
    prompt: string;
    directory: string;
    sessionId?: string;
    capabilities?: readonly string[];
}
export interface AgentProcess {
    child: ChildProcess;
    pid: number;
    pgid: number | undefined;
}
export interface AccountRequest {
    refresh?: boolean;
}
/** Consumers use capabilities and typed operations, never command-line fragments. */
export interface AgentClient {
    readonly id: string;
    readonly capabilities: {
        readonly run: boolean;
        readonly account: boolean;
    };
    run(request: AgentRun, options?: ClientOptions): Promise<ExecutionResult>;
    start(request: AgentRun, options?: ClientOptions): AgentProcess;
    readAccount?(request?: AccountRequest, options?: ClientOptions): Promise<unknown>;
}
export class ClientError extends Error {
    constructor(readonly code: string, message = 'Client operation unavailable') { super(message); this.name = 'ClientError'; }
}
export abstract class ForgeAgentClient implements AgentClient {
    abstract readonly id: string;
    readonly capabilities: {
        readonly run: boolean;
        readonly account: boolean;
    } = { run: true, account: false };
    constructor(protected readonly execution = new ForgeExecutor()) { }
    private args(request: AgentRun, format: 'json' | 'stream-json'): string[] {
        if (!isAbsolute(request.directory))
            throw new Error('Agent directory must be absolute');
        if (!request.profile.trim())
            throw new Error('A resolved agent profile is required');
        if (request.profile.includes(':') && request.profile.slice(request.profile.lastIndexOf(':') + 1) !== this.id)
            throw new Error('Profile does not match the selected client');
        if (request.sessionId && /^fg_\d{8}_[0-9a-f]{4}$/.test(request.sessionId))
            throw new Error('Resume requires a native client session id');
        return ['--profile', request.profile, '--permission', 'yolo', '-C', request.directory, '-f', format,
            ...(request.sessionId ? ['-r', request.sessionId] : []), ...(request.capabilities ?? []).flatMap(id => ['--cap', id])];
    }
    run(request: AgentRun, options?: ClientOptions): Promise<ExecutionResult> {
        return this.execution.run(this.args(request, 'json'), { ...options, cwd: request.directory, input: request.prompt });
    }
    /** Streaming lifecycle is owned by the caller, including cancellation and reaping. */
    start(request: AgentRun, options?: ClientOptions): AgentProcess {
        options?.signal?.throwIfAborted();
        const child = this.execution.spawn(this.args(request, 'stream-json'), { cwd: request.directory, env: options?.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
        if (!child.pid) {
            child.once('error', () => { });
            throw new Error('Failed to start agent client');
        }
        child.stdin?.on('error', () => { });
        child.stdin?.end(request.prompt);
        return { child, pid: child.pid, pgid: process.platform === 'win32' ? undefined : child.pid };
    }
}
export function observation(source: string, data: unknown): unknown {
    return { source, fetched_at: new Date().toISOString(), data };
}
export async function requestJson(url: string, init: RequestInit, options?: ClientOptions): Promise<unknown> {
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
