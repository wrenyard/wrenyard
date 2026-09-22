import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NativeClientReadiness, ReadinessOptions } from '@wrenyard/agent-client';

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
