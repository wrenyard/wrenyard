import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Native Grok OAuth candidate paths in required precedence: Wrenyard's managed
 * client home first, then the official default Grok home. Mirrors the
 * retired Go OAuthCandidates helper.
 */
export function grokOAuthCandidates(env: NodeJS.ProcessEnv = process.env, home?: string): string[] {
    const base = home?.trim() || env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
    const dataHome = env.XDG_DATA_HOME?.trim() || join(base, '.local', 'share');
    return [
        join(dataHome, 'wrenyard', 'clients', 'grok', 'auth.json'),
        join(base, '.grok', 'auth.json'),
    ];
}

/**
 * Return every readable regular-file OAuth candidate without selecting one.
 * Unreadable or non-regular entries are dropped; nothing is copied or logged.
 */
export async function readableGrokOAuthSources(env: NodeJS.ProcessEnv = process.env, home?: string): Promise<string[]> {
    const readable: string[] = [];
    for (const candidate of grokOAuthCandidates(env, home)) {
        const info = await stat(candidate).catch(() => undefined);
        if (!info?.isFile())
            continue;
        // Opening read-only and closing is enough to confirm readability; the
        // file is never read here, so no unbounded readFile is needed.
        const handle = await open(candidate, 'r').catch(() => undefined);
        if (!handle)
            continue;
        await handle.close().catch(() => undefined);
        readable.push(candidate);
    }
    return readable;
}
