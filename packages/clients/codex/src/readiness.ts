import { mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { NativeClientReadiness, ReadinessOptions } from '@wrenyard/agent-client';
import { clientStateDirForEnv } from '@wrenyard/agent-client/native';
import { Executor, rpcSequence } from '@wrenyard/execution';
import { inspectCodex } from './installation.ts';

/**
 * Bounded byte ceiling for the Codex auth.json probe. Real files are a few
 * kilobytes; anything larger is treated as unknown rather than parsed.
 */
const MAX_AUTH_BYTES = 256 * 1024;

/**
 * Resolve the native Codex auth.json path exactly like the retired Go resolver:
 * an explicit CODEX_HOME wins, otherwise `<home>/.codex/auth.json`. HOME and
 * USERPROFILE feed the home fallback.
 */
export function codexAuthPath(env: NodeJS.ProcessEnv = process.env, home?: string): string {
    const codexHome = env.CODEX_HOME?.trim();
    if (codexHome) return join(codexHome, 'auth.json');
    const base = home?.trim() || env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
    return join(base, '.codex', 'auth.json');
}

/**
 * Observe the native Codex login without starting the model/app-server or
 * issuing inference. Only the presence of a non-empty `tokens.access_token`
 * counts as ready; a missing/unreadable/invalid file is missing, and any
 * ambiguous read stays unknown.
 */
export async function readCodexReadiness(options?: ReadinessOptions): Promise<NativeClientReadiness> {
    const env = options?.env ?? process.env;
    const path = codexAuthPath(env, options?.home);
    let raw: string;
    try {
        const handle = await open(path, 'r');
        try {
            const info = await handle.stat();
            if (info.size > MAX_AUTH_BYTES) return { authentication: 'unknown' };
            raw = await handle.readFile({ encoding: 'utf8' });
        } finally {
            await handle.close().catch(() => undefined);
        }
    } catch (error) {
        return { authentication: isMissing(error) ? 'missing' : 'unknown' };
    }
    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch {
        return { authentication: 'missing' };
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { authentication: 'missing' };
    const tokens = (data as Record<string, unknown>).tokens;
    if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) return { authentication: 'missing' };
    const accessToken = (tokens as Record<string, unknown>).access_token;
    return typeof accessToken === 'string' && accessToken !== ''
        ? { authentication: 'ready' }
        : { authentication: 'missing' };
}

function isMissing(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
}

const MAX_SOURCE_AUTH_BYTES = 1024 * 1024;
const REFRESH_TIMEOUT_MS = 8_000;
const refreshQueues = new Map<string, Promise<void>>();

type CodexLogin = {
    type: 'chatgptAuthTokens';
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType?: string;
} | { type: 'apiKey'; apiKey: string };

export interface CodexAuth {
    readonly isolatedHome: string;
    readonly sourceHome?: string;
    readonly login?: CodexLogin;
    readonly sourceEnv: NodeJS.ProcessEnv;
}

/** Keep native Codex session data separate from the user's Desktop inventory. */
export function isolatedCodexHome(env: NodeJS.ProcessEnv): string {
    return clientStateDirForEnv(env, 'codex');
}

export async function prepareCodexAuth(env: NodeJS.ProcessEnv, isolatedHome: string, native: boolean): Promise<CodexAuth> {
    const sourceHome = dirname(codexAuthPath(env));
    if (samePath(sourceHome, isolatedHome))
        throw new Error('Codex source and isolated homes must differ');
    await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
    return {
        isolatedHome,
        sourceEnv: env,
        ...(native ? { sourceHome, login: loginParams(await readSourceAuth(sourceHome)) } : {}),
    };
}

/** A complete child environment; no source auth or inherited native API key enters the isolated home. */
export function codexChildEnv(env: NodeJS.ProcessEnv, isolatedHome: string, native: boolean): Record<string, string> {
    const child: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (typeof value !== 'string') continue;
        const normalized = key.toUpperCase();
        if (normalized === 'CODEX_HOME' || (native && (normalized === 'CODEX_API_KEY' || normalized === 'OPENAI_API_KEY')))
            continue;
        child[key] = value;
    }
    child.CODEX_HOME = isolatedHome;
    return child;
}

export async function refreshCodexAuth(auth: CodexAuth, executable: string, previousAccess: string, signal: AbortSignal): Promise<CodexLogin> {
    if (!auth.sourceHome || auth.login?.type !== 'chatgptAuthTokens')
        throw new Error('Codex ChatGPT refresh is unavailable');
    const home = auth.sourceHome;
    return withRefreshQueue(home, async () => {
        const current = await readSourceAuth(home);
        if (current.accessToken && current.accessToken !== previousAccess)
            return loginParams(current);
        if (!current.hasRefreshToken)
            return loginParams(current);
        try {
            await rpcSequence(new Executor(), {
                command: executable,
                args: ['app-server', '--stdio'],
                env: { CODEX_HOME: home, CODEX_API_KEY: null, OPENAI_API_KEY: null },
                steps: [
                    { method: 'initialize', params: { clientInfo: { name: 'wrenyard', title: 'Wrenyard', version: '1' } } },
                    { method: 'initialized', notification: true },
                    { method: 'account/read', params: { refreshToken: true } },
                ],
            }, { env: auth.sourceEnv, signal, timeoutMs: REFRESH_TIMEOUT_MS });
        } catch {
            throw new Error('Native Codex authentication refresh failed');
        }
        const refreshed = loginParams(await readSourceAuth(home));
        if (refreshed.type !== 'chatgptAuthTokens')
            throw new Error('Native Codex refresh produced no ChatGPT token');
        return refreshed;
    });
}

/**
 * Resolve the Codex source auth home used by the Model Gateway exactly like the
 * native path: the directory of the CODEX_HOME / home-derived auth.json.
 */
export function codexSourceAuthHome(env: NodeJS.ProcessEnv = process.env, home?: string): string {
    return dirname(codexAuthPath(env, home));
}

/** ChatGPT token plus account id, the exact pair the subscription endpoint needs. */
export interface CodexGatewayCredential {
    readonly accessToken: string;
    readonly accountId: string;
}

export interface CodexGatewayAuthOptions {
    readonly env?: NodeJS.ProcessEnv;
    /** Optional explicit home override, mirroring the native readiness path. */
    readonly home?: string;
    /** Optional installed Codex executable; when absent the existing lookup runs. */
    readonly executable?: string;
}

/**
 * Read the ChatGPT subscription credential for the Model Gateway from the same
 * source auth.json the native client already uses. Only a ChatGPT auth-token
 * login is usable here; an API-key login is rejected because this is a
 * subscription endpoint. The token and account id are returned to the caller
 * and never logged.
 */
export async function readCodexGatewayCredential(options: CodexGatewayAuthOptions = {}): Promise<CodexGatewayCredential> {
    const env = options.env ?? process.env;
    const sourceHome = codexSourceAuthHome(env, options.home);
    const login = loginParams(await readSourceAuth(sourceHome));
    if (login.type !== 'chatgptAuthTokens') throw new Error('Codex ChatGPT gateway requires a ChatGPT login');
    return { accessToken: login.accessToken, accountId: login.chatgptAccountId };
}

/**
 * Refresh the gateway credential through the SAME serialized app-server
 * `account/read` refresh the native path already uses (refreshCodexAuth). It
 * reuses a token already rotated into the source file, and otherwise spawns the
 * existing Codex app-server with an executable that is either injected or
 * resolved by the existing inspectCodex lookup. No new login or token-refresh
 * HTTP implementation is introduced.
 */
export async function refreshCodexGatewayCredential(
    credential: CodexGatewayCredential,
    options: CodexGatewayAuthOptions & { readonly signal: AbortSignal },
): Promise<CodexGatewayCredential> {
    const env = options.env ?? process.env;
    const sourceHome = codexSourceAuthHome(env, options.home);
    const executable = options.executable?.trim() || await resolveCodexExecutable(env);
    const auth: CodexAuth = {
        isolatedHome: sourceHome,
        sourceHome,
        login: {
            type: 'chatgptAuthTokens',
            accessToken: credential.accessToken,
            chatgptAccountId: credential.accountId,
        },
        sourceEnv: env,
    };
    const refreshed = await refreshCodexAuth(auth, executable, credential.accessToken, options.signal);
    if (refreshed.type !== 'chatgptAuthTokens') throw new Error('Native Codex refresh produced no ChatGPT token');
    return { accessToken: refreshed.accessToken, accountId: refreshed.chatgptAccountId };
}

async function resolveCodexExecutable(env: NodeJS.ProcessEnv): Promise<string> {
    const status = await inspectCodex({ env });
    if (status.installation.state !== 'installed') throw new Error('Codex CLI is not installed');
    return status.installation.executable;
}

interface SourceAuth {
    readonly accessToken: string;
    readonly accountId: string;
    readonly planType: string;
    readonly apiKey: string;
    readonly hasRefreshToken: boolean;
}

async function readSourceAuth(home: string): Promise<SourceAuth> {
    let text: string;
    try {
        const file = await open(join(home, 'auth.json'), 'r');
        try {
            const info = await file.stat();
            if (!info.isFile() || info.size > MAX_SOURCE_AUTH_BYTES)
                throw new Error('Codex auth.json is unavailable');
            text = await file.readFile({ encoding: 'utf8' });
        } finally {
            await file.close();
        }
    } catch {
        throw new Error('Codex auth.json is unavailable');
    }
    let data: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(text);
        if (!record(parsed)) throw new Error('invalid');
        data = parsed;
    } catch {
        throw new Error('Codex auth.json is invalid');
    }
    const tokens = record(data.tokens) ? data.tokens : {};
    return {
        accessToken: field(tokens, 'access_token'),
        accountId: field(tokens, 'account_id'),
        planType: field(tokens, 'plan_type') || field(data, 'plan_type'),
        apiKey: field(data, 'OPENAI_API_KEY'),
        hasRefreshToken: Boolean(field(tokens, 'refresh_token')),
    };
}

function loginParams(auth: SourceAuth): CodexLogin {
    if (auth.accessToken) {
        if (!auth.accountId) throw new Error('Codex ChatGPT token has no account id');
        return {
            type: 'chatgptAuthTokens',
            accessToken: auth.accessToken,
            chatgptAccountId: auth.accountId,
            ...(auth.planType ? { chatgptPlanType: auth.planType } : {}),
        };
    }
    if (auth.apiKey) return { type: 'apiKey', apiKey: auth.apiKey };
    throw new Error('Codex auth.json has no usable credential');
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function field(value: Record<string, unknown>, key: string): string {
    const raw = value[key];
    return typeof raw === 'string' ? raw.trim() : '';
}

function samePath(left: string, right: string): boolean {
    const a = resolve(left), b = resolve(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Serialize refreshes within the daemon and reuse a token refreshed by an earlier run. */
async function withRefreshQueue<T>(home: string, run: () => Promise<T>): Promise<T> {
    const previous = refreshQueues.get(home);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    refreshQueues.set(home, current);
    try {
        if (previous) await previous;
        return await run();
    } finally {
        if (refreshQueues.get(home) === current) refreshQueues.delete(home);
        release();
    }
}
