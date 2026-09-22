import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readKeychain, type Executor, type ExecutionOptions } from '@wrenyard/execution';
import { ClientError } from '@wrenyard/agent-client';

/** Keychain service holding Claude Code OAuth credentials on macOS. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
/** Legacy account names probed when the service-name lookup finds nothing. */
const KEYCHAIN_FALLBACK_ACCOUNTS = ['oauth.claude'];
/** macOS access prompt popups are throttled to this interval after a failed read. */
const KEYCHAIN_COOLDOWN_MS = 30 * 60 * 1000;
/** A cached token this close to expiry is treated as stale and refreshed. */
const EXPIRY_SAFETY_MARGIN_MS = 60 * 1000;
/** Default OAuth refresh endpoint and request timeout, mirroring the old runtime. */
const REFRESH_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const REFRESH_TIMEOUT_MS = 5000;
const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024;

export interface ClaudeCredential {
    accessToken: string;
    refreshToken?: string;
    /** Epoch milliseconds; absent when the source omits an expiry. */
    expiresAt?: number;
}

export interface ClaudeCredentialOptions {
    /** Account options: the complete environment plus cancellation/timeout. */
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}

/**
 * Resolve the live Claude OAuth access token. Precedence mirrors the retired Go
 * store: an unexpired disk cache wins first, an expired cached token is
 * refreshed, a lazy keychain read (subject to cooldown) may replace both, and
 * the on-disk credentials file is the final fallback. A token obtained from the
 * keychain or the credentials file is refreshed when expired too, not only a
 * cached one. Refresh never runs silently against a real token during tests;
 * callers supply the environment.
 */
export async function readClaudeCredential(execution: Executor, options?: ClaudeCredentialOptions): Promise<ClaudeCredential> {
    const env = options?.env ?? process.env;
    const home = env.HOME || env.USERPROFILE || homedir();
    const credentialsPath = join(home, '.claude', '.credentials.json');
    const cachePath = join(claudeDataDir(env, home), 'claude-credential.json');
    let cached: ClaudeCredential | undefined;
    let cachedRead = false;

    try {
        cached = await readCredentialCache(cachePath);
        cachedRead = true;
    }
    catch { /* A missing or malformed cache is treated as absent. */ }

    throwIfAborted(options);

    if (cached && !isExpired(cached))
        return cached;

    if (cached?.refreshToken) {
        const refreshed = await tryRefresh(cached.refreshToken, options);
        if (refreshed?.accessToken) {
            await writeCredentialCache(cachePath, refreshed).catch(() => undefined);
            return refreshed;
        }
    }

    throwIfAborted(options);

    if (await keychainAvailable(execution, env)) {
        const keychainCredential = await tryLazyKeychain(execution, cachePath, env, options);
        if (keychainCredential)
            return await resolveExpired(keychainCredential, cachePath, options);
    }

    let fileCredential: ClaudeCredential | undefined;
    try {
        const info = await stat(credentialsPath);
        if (info.size > MAX_CREDENTIAL_FILE_BYTES)
            throw new ClientError('authentication_required');
        fileCredential = parseClaudeCredential(JSON.parse(await readFile(credentialsPath, 'utf8')));
    }
    catch (error) {
        if (error instanceof ClientError)
            throw error;
        if (cachedRead && cached)
            return cached;
        throw new ClientError('authentication_required');
    }
    if (!fileCredential.accessToken) {
        if (cachedRead && cached)
            return cached;
        throw new ClientError('authentication_required');
    }
    return await resolveExpired(fileCredential, cachePath, options);
}

/** True when the credential has a known expiry at or inside the safety margin. */
function isExpired(credential: ClaudeCredential): boolean {
    return credential.expiresAt !== undefined && credential.expiresAt - Date.now() <= EXPIRY_SAFETY_MARGIN_MS;
}

/**
 * A missing expiry means "unknown", not "expired": only refresh when the token
 * carries a known expiry that has passed, exactly as the retired Go store did.
 */
async function resolveExpired(credential: ClaudeCredential, cachePath: string, options?: ClaudeCredentialOptions): Promise<ClaudeCredential> {
    if (!isExpired(credential) || !credential.refreshToken) {
        await writeCredentialCache(cachePath, credential).catch(() => undefined);
        return credential;
    }
    const refreshed = await tryRefresh(credential.refreshToken, options);
    const result = refreshed?.accessToken ? refreshed : credential;
    await writeCredentialCache(cachePath, result).catch(() => undefined);
    return result;
}

/** Honor a pre-existing cancellation without re-issuing aborted work. */
function throwIfAborted(options?: ClaudeCredentialOptions): void {
    if (options?.signal?.aborted)
        throw options.signal.reason ?? new ClientError('authentication_required');
}

/** The legacy filesystem-rooted data dir, used only for the credential cache. */
function claudeDataDir(env: NodeJS.ProcessEnv, home: string): string {
    const dataHome = env.XDG_DATA_HOME?.trim();
    return join(dataHome && dataHome.length > 0 ? dataHome : join(home, '.local', 'share'), 'wrenyard', 'clients', 'claude');
}

async function keychainAvailable(execution: Executor, env: NodeJS.ProcessEnv): Promise<boolean> {
    if (env.WRENYARD_DISABLE_KEYCHAIN === '1')
        return false;
    // The generic keychain primitive only exists on macOS; other platforms
    // report an unsupported operation, which the probe turns into a skip.
    return process.platform === 'darwin' && execution !== undefined;
}

async function tryLazyKeychain(execution: Executor, cachePath: string, env: NodeJS.ProcessEnv, options?: ClaudeCredentialOptions): Promise<ClaudeCredential | undefined> {
    const markerPath = keychainAttemptMarkerPath(cachePath);
    if (await withinCooldown(markerPath))
        return undefined;
    try {
        const raw = await readKeychainValue(execution, env, options);
        await writeKeychainMarker(markerPath, true);
        const credential = parseClaudeCredential(JSON.parse(raw));
        if (!credential.accessToken)
            return undefined;
        await writeCredentialCache(cachePath, credential).catch(() => undefined);
        await rm(markerPath, { force: true }).catch(() => undefined);
        return credential;
    }
    catch {
        await writeKeychainMarker(markerPath, false);
        return undefined;
    }
}

async function readKeychainValue(execution: Executor, env: NodeJS.ProcessEnv, options?: ClaudeCredentialOptions): Promise<string> {
    const executionOptions: ExecutionOptions = { env, signal: options?.signal, timeoutMs: options?.timeoutMs };
    const accounts = [env.USER, env.LOGNAME, ...KEYCHAIN_FALLBACK_ACCOUNTS].filter((value): value is string => Boolean(value?.trim()));
    let lastError: unknown;
    try {
        return await readKeychain(execution, KEYCHAIN_SERVICE, undefined, executionOptions);
    }
    catch (error) {
        lastError = error;
    }
    for (const account of accounts) {
        try {
            return await readKeychain(execution, KEYCHAIN_SERVICE, account, executionOptions);
        }
        catch (error) {
            lastError = error;
        }
    }
    throw lastError ?? new ClientError('authentication_required');
}

function keychainAttemptMarkerPath(cachePath: string): string {
    return cachePath.endsWith('.json') ? `${cachePath.slice(0, -'.json'.length)}-keychain-attempt.json` : `${cachePath}-keychain-attempt.json`;
}

async function withinCooldown(markerPath: string): Promise<boolean> {
    try {
        const info = await stat(markerPath);
        return Date.now() - info.mtimeMs < KEYCHAIN_COOLDOWN_MS;
    }
    catch {
        return false;
    }
}

async function writeKeychainMarker(markerPath: string, success: boolean): Promise<void> {
    await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 }).catch(() => undefined);
    await writeFile(markerPath, JSON.stringify({ attempted_at: new Date().toISOString(), success }), { mode: 0o600 }).catch(() => undefined);
}

async function tryRefresh(refreshToken: string, options?: ClaudeCredentialOptions): Promise<ClaudeCredential | undefined> {
    const timeout = AbortSignal.timeout(Math.min(options?.timeoutMs ?? REFRESH_TIMEOUT_MS, REFRESH_TIMEOUT_MS));
    const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
        const response = await fetch(REFRESH_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
            redirect: 'error',
            signal,
        });
        if (!response.ok) {
            await response.body?.cancel();
            return undefined;
        }
        const credential = parseClaudeCredential(JSON.parse(await response.text()));
        // Providers commonly omit refresh_token on refresh; keep the prior one.
        if (!credential.refreshToken)
            credential.refreshToken = refreshToken;
        return credential.accessToken ? credential : undefined;
    }
    catch {
        return undefined;
    }
}

/** Accepts either the raw OAuth object or the `claudeAiOauth`-wrapped shape. */
export function parseClaudeCredential(raw: unknown): ClaudeCredential {
    if (!raw || typeof raw !== 'object')
        return { accessToken: '' };
    let root = raw as Record<string, unknown>;
    const nested = root.claudeAiOauth;
    if (nested && typeof nested === 'object' && !Array.isArray(nested))
        root = nested as Record<string, unknown>;
    if (typeof root.accessToken !== 'string') {
        for (const value of Object.values(root)) {
            if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).accessToken === 'string') {
                root = value as Record<string, unknown>;
                break;
            }
        }
    }
    const expiresRaw = root.expiresAt ?? root.expires_at;
    const expires = parseTimestamp(expiresRaw);
    const credential: ClaudeCredential = { accessToken: typeof root.accessToken === 'string' ? root.accessToken : '' };
    if (typeof root.refreshToken === 'string' && root.refreshToken)
        credential.refreshToken = root.refreshToken;
    if (expires !== undefined && expires > 0)
        credential.expiresAt = expires;
    return credential;
}

/**
 * Accept an epoch-millis number, an epoch-seconds number, or an ISO/RFC3339
 * date string. Number('2026-...Z') is NaN, so strings must go through
 * Date.parse rather than numeric coercion. Returns undefined when the source
 * omits or malforms the expiry, which callers treat as "unknown", not epoch 0.
 */
function parseTimestamp(raw: unknown): number | undefined {
    if (typeof raw === 'number')
        return Number.isFinite(raw) ? raw : undefined;
    if (typeof raw !== 'string')
        return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        return undefined;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        const numeric = Number(trimmed);
        // A seconds-precision epoch is far below the millisecond range.
        if (Number.isFinite(numeric) && numeric > 0 && numeric < 1e12)
            return numeric * 1000;
        return Number.isFinite(numeric) ? numeric : undefined;
    }
    const millis = Date.parse(trimmed);
    return Number.isFinite(millis) ? millis : undefined;
}

async function readCredentialCache(path: string): Promise<ClaudeCredential | undefined> {
    const info = await stat(path);
    if (info.size > MAX_CREDENTIAL_FILE_BYTES)
        return undefined;
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    if (typeof raw.access_token !== 'string' || !raw.access_token)
        return undefined;
    const credential: ClaudeCredential = { accessToken: raw.access_token };
    if (typeof raw.refresh_token === 'string' && raw.refresh_token)
        credential.refreshToken = raw.refresh_token;
    // The Go writer encodes an unknown expiry as the zero time
    // ("0001-01-01T00:00:00Z"); preserve the schema by treating it as absent
    // rather than a genuinely expired (epoch-1970) token.
    if (typeof raw.expires_at === 'string') {
        const millis = parseTimestamp(raw.expires_at);
        if (millis !== undefined && yearOf(millis) > 1)
            credential.expiresAt = millis;
    }
    return credential;
}

/** Calendar year of an epoch-millis instant, used to spot the Go zero time. */
function yearOf(millis: number): number {
    return new Date(millis).getUTCFullYear();
}

async function writeCredentialCache(path: string, credential: ClaudeCredential): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({
        access_token: credential.accessToken,
        refresh_token: credential.refreshToken ?? '',
        // Unknown expiry round-trips as the Go zero time, matching the legacy
        // schema; only a known expiry becomes a real instant.
        expires_at: credential.expiresAt !== undefined && credential.expiresAt > 0 ? new Date(credential.expiresAt).toISOString() : '0001-01-01T00:00:00Z',
        cached_at: new Date().toISOString(),
    });
    // Atomic write via a unique temp file so a pre-existing symlink or loose
    // permission file can never leak the token.
    const temporary = `${path}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`;
    try {
        await writeFile(temporary, payload, { mode: 0o600 });
        await rename(temporary, path);
    }
    catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}
