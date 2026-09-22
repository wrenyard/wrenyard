import { readSqliteValue, type Executor, type ExecutionOptions } from '@wrenyard/execution';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Cursor Desktop persists its OAuth access token in the state.vscdb ItemTable
 * under this key. Only the query and value live here; Forge executes the
 * read-only SQLite primitive.
 */
const ACCESS_TOKEN_QUERY = 'SELECT value FROM ItemTable WHERE key = ?';
const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';

export interface CursorCredentialOptions {
    readonly home?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}

/**
 * Resolve the Cursor Desktop state database path for the current platform.
 * Precedence mirrors the retired Go helper: HOME, then USERPROFILE, with
 * APPDATA on Windows and XDG_CONFIG_HOME elsewhere. An explicit home disables
 * the platform environment overrides.
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
        default: {
            const config = explicitHome ? '' : env.XDG_CONFIG_HOME?.trim();
            return join(config || join(base, '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
        }
    }
}

/**
 * Read the Cursor Desktop access token. The token is never cached, logged, or
 * persisted, and every failure is surfaced as a sanitized client error.
 */
export async function readCursorCredential(execution: Executor, options?: CursorCredentialOptions): Promise<string> {
    const env = options?.env ?? process.env;
    const executionOptions: ExecutionOptions = { env, signal: options?.signal, timeoutMs: options?.timeoutMs };
    const token = await readSqliteValue(execution, cursorStatePath(env, options?.home), ACCESS_TOKEN_QUERY, [ACCESS_TOKEN_KEY], executionOptions);
    return token;
}
