import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';

export const DEFAULT_SERVER = 'https://server.codeium.com';
export interface DevinCredentials { key: string; server: string; fingerprint: string }

export function credentialsPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'devin', 'credentials.toml');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'devin', 'credentials.toml');
}

export async function readDevinCredentials(options: {
  env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string;
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
} = {}): Promise<DevinCredentials | undefined> {
  const env = options.env ?? process.env;
  try {
    const text = await (options.readFile ?? ((path, encoding) => readFile(path, encoding)))(
      credentialsPath(env, options.platform ?? process.platform, options.home ?? homedir()), 'utf8',
    );
    const data = parse(text) as Record<string, unknown>;
    const key = typeof data.windsurf_api_key === 'string' ? data.windsurf_api_key.trim() : '';
    if (!key) return undefined;
    const serverValue = data.api_server_url || DEFAULT_SERVER;
    if (typeof serverValue !== 'string' || new URL(serverValue).protocol !== 'https:') return undefined;
    const server = serverValue.replace(/\/+$/, '');
    // Opaque digest binds snapshots without retaining or exposing the secret in cache keys.
    const fingerprint = createHash('sha256').update(`${server}\0${key}`).digest('hex');
    return { key, server, fingerprint };
  } catch { return undefined; }
}
