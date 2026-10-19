import { NativeOperationError, readKeychain, readSqliteValue, type Executor, type ExecutionOptions } from '@wrenyard/execution';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Cursor Desktop persists its OAuth access token in the state.vscdb ItemTable
 * under this key. Only the query and value live here; Forge executes the
 * read-only SQLite primitive.
 */
const ACCESS_TOKEN_QUERY = 'SELECT value FROM ItemTable WHERE key = ?';
const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';

/**
 * Cursor Agent CLI credential store. The CLI derives keychain service names
 * from its domain `cursor`: service `cursor-access-token` under account
 * `cursor-user`, and an auth.json file store on non-darwin platforms. These
 * constants mirror that contract so Wrenyard reads what the CLI it launches
 * actually uses.
 */
const CLI_KEYCHAIN_SERVICE = 'cursor-access-token';
const CLI_KEYCHAIN_ACCOUNT = 'cursor-user';
const CLI_STORE_ENV = 'AGENT_CLI_CREDENTIAL_STORE';
const MAX_AUTH_FILE_BYTES = 1024 * 1024;

export interface CursorCredentialOptions {
    readonly home?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}

/**
 * Resolve the Cursor Desktop state database path for the current platform.
 * Precedence mirrors the retired Go helper: HOME, then USERPROFILE, with
 * APPDATA on Windows and `~/.config` elsewhere. Cursor is an external
 * application, so its credential location is never relocated under Wrenyard.
 * An explicit home disables the platform environment overrides.
 */
export function cursorStatePath(env: NodeJS.ProcessEnv = process.env, home?: string): string {
    const explicitHome = Boolean(home?.trim());
    const base = explicitHome ? home!.trim() : (env.HOME?.trim() || env.USERPROFILE?.trim() || homedir());
    switch (process.platform) {
        case 'darwin':
            return join(base, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
        case 'win32': {
            const appData = explicitHome ? '' : env.APPDATA?.trim();
            return join(appData || join(base, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
        }
        default:
            return join(base, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    }
}

/**
 * Resolve the Cursor Agent CLI auth file path, mirroring the CLI's own file
 * store: `~/.cursor/auth.json` on macOS, APPDATA on Windows, XDG_CONFIG_HOME
 * (or `~/.config`) elsewhere. An explicit home disables the platform
 * environment overrides, exactly like cursorStatePath.
 */
function cliAuthPath(env: NodeJS.ProcessEnv, home?: string): string {
    const explicitHome = Boolean(home?.trim());
    const base = explicitHome ? home!.trim() : (env.HOME?.trim() || env.USERPROFILE?.trim() || homedir());
    switch (process.platform) {
        case 'darwin':
            return join(base, '.cursor', 'auth.json');
        case 'win32': {
            const appData = explicitHome ? '' : env.APPDATA?.trim();
            return join(appData || join(base, 'AppData', 'Roaming'), 'Cursor', 'auth.json');
        }
        default: {
            const config = explicitHome ? '' : env.XDG_CONFIG_HOME?.trim();
            return join(config || join(base, '.config'), 'cursor', 'auth.json');
        }
    }
}

/**
 * Which credential store the Cursor Agent CLI reads for itself. It honors
 * AGENT_CLI_CREDENTIAL_STORE (`file`, `memory`) and otherwise defaults to the
 * macOS keychain on darwin and the auth file everywhere else. A memory store
 * is process-private and cannot be read from outside, so it has no source
 * here; the Desktop database remains as the fallback.
 */
function cliCredentialStoreKind(env: NodeJS.ProcessEnv): 'keychain' | 'file' | 'none' {
    const requested = env[CLI_STORE_ENV];
    if (requested === 'file') return 'file';
    if (requested === 'memory') return 'none';
    return process.platform === 'darwin' ? 'keychain' : 'file';
}

/** Store outcomes that mean "no credential stored", not a read failure. */
function isMissingStoreValue(error: unknown): boolean {
    return error instanceof NativeOperationError
        && (error.code === 'no_stored_value' || error.code === 'keychain_item_not_found' || error.code === 'keychain_value_empty');
}

function asNativeOperationError(error: unknown): NativeOperationError {
    return error instanceof NativeOperationError ? error : new NativeOperationError('native_operation_failed');
}

interface AuthFileOutcome {
    readonly token?: string;
    readonly error?: NativeOperationError;
}

/**
 * Read the CLI auth.json store. A missing file, or a file without a usable
 * access token, means the CLI is not logged in; a present but unreadable file
 * is a store failure. Only the single accessToken field is taken from the
 * parsed document and the rest is discarded.
 */
async function readCliAuthFile(path: string): Promise<AuthFileOutcome> {
    let info;
    try {
        info = await stat(path);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return {};
        return { error: new NativeOperationError('credential_file_unavailable') };
    }
    if (!info.isFile()) return {};
    if (info.size > MAX_AUTH_FILE_BYTES) return { error: new NativeOperationError('value_too_large') };
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch {
        return { error: new NativeOperationError('credential_file_unavailable') };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { error: new NativeOperationError('credential_file_invalid') };
    }
    const accessToken = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { accessToken?: unknown }).accessToken
        : undefined;
    if (typeof accessToken === 'string' && accessToken.trim() !== '') return { token: accessToken };
    return {};
}

/**
 * Read the Cursor access token. The Cursor Agent CLI credential store comes
 * first — keychain on macOS, auth.json elsewhere, honoring the CLI store
 * override — and the Desktop state database is the compatibility fallback.
 * An explicit home isolates every file source under it; the global keychain
 * cannot be relocated, so it is skipped instead of probing real credentials
 * outside the isolation boundary. Absent credentials in every enabled store
 * resolve to an empty string, while store failures propagate as sanitized
 * NativeOperationError codes, so missing and broken stay distinguishable. The
 * token is never cached, logged, or persisted.
 */
export async function readCursorCredential(execution: Executor, options?: CursorCredentialOptions): Promise<string> {
    const env = options?.env ?? process.env;
    const executionOptions: ExecutionOptions = { env, signal: options?.signal, timeoutMs: options?.timeoutMs };
    let storeFailure: NativeOperationError | undefined;

    const kind = cliCredentialStoreKind(env);
    if (kind === 'keychain' && !options?.home?.trim()) {
        try {
            return await readKeychain(execution, CLI_KEYCHAIN_SERVICE, CLI_KEYCHAIN_ACCOUNT, executionOptions);
        } catch (error) {
            if (!isMissingStoreValue(error)) storeFailure = asNativeOperationError(error);
        }
    } else if (kind === 'file') {
        const outcome = await readCliAuthFile(cliAuthPath(env, options?.home));
        if (outcome.token !== undefined) return outcome.token;
        if (outcome.error !== undefined) storeFailure = outcome.error;
    }

    const desktopPath = cursorStatePath(env, options?.home);
    let desktopPresent = true;
    try {
        await stat(desktopPath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') desktopPresent = false;
        else if (storeFailure === undefined) storeFailure = new NativeOperationError('credential_file_unavailable');
    }
    if (desktopPresent) {
        try {
            const token = await readSqliteValue(execution, desktopPath, ACCESS_TOKEN_QUERY, [ACCESS_TOKEN_KEY], executionOptions);
            if (token.trim() !== '') return token;
        } catch (error) {
            if (!isMissingStoreValue(error) && storeFailure === undefined) storeFailure = asNativeOperationError(error);
        }
    }

    if (storeFailure !== undefined) throw storeFailure;
    return '';
}
