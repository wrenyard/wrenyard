import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NativeClientReadiness, ReadinessOptions } from '@wrenyard/agent-client';

const MAX_AUTH_BYTES = 256 * 1024;

/** Resolve the Pi agent directory from PI_CODING_AGENT_DIR or ~/.pi/agent. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env, home?: string): string {
    const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
    if (fromEnv)
        return fromEnv;
    const base = home?.trim() || env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
    return join(base, '.pi', 'agent');
}

/**
 * Observe native Pi authentication from auth.json only. A missing file is
 * missing; a usable api_key or oauth token is ready; other cases stay unknown.
 */
export async function readPiReadiness(options?: ReadinessOptions): Promise<NativeClientReadiness> {
    const env = options?.env ?? process.env;
    const path = join(piAgentDir(env, options?.home), 'auth.json');
    let raw: string;
    try {
        const handle = await open(path, 'r');
        try {
            const info = await handle.stat();
            if (info.size > MAX_AUTH_BYTES)
                return { authentication: 'unknown' };
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
        return { authentication: 'unknown' };
    }
    return { authentication: authReady(data) ? 'ready' : 'missing' };
}

function authReady(data: unknown): boolean {
    if (data === null || typeof data !== 'object' || Array.isArray(data))
        return false;
    const root = data as Record<string, unknown>;
    if (nonEmptyString(root.api_key))
        return true;
    const oauth = root.oauth;
    if (oauth !== null && typeof oauth === 'object' && !Array.isArray(oauth)) {
        const token = (oauth as Record<string, unknown>).token;
        if (nonEmptyString(token))
            return true;
    }
    for (const value of Object.values(root)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            continue;
        const entry = value as Record<string, unknown>;
        if (entry.type === 'api_key' && nonEmptyString(entry.key))
            return true;
        if (entry.type === 'oauth') {
            if (nonEmptyString(entry.access_token) || nonEmptyString(entry.token))
                return true;
        }
        if (nonEmptyString(entry.api_key))
            return true;
        const nestedOauth = entry.oauth;
        if (nestedOauth !== null && typeof nestedOauth === 'object' && !Array.isArray(nestedOauth)) {
            if (nonEmptyString((nestedOauth as Record<string, unknown>).token))
                return true;
        }
    }
    return false;
}

function nonEmptyString(value: unknown): boolean {
    return typeof value === 'string' && value.trim() !== '';
}

function isMissing(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
}
