import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findExecutable, type ClientStatus, type InspectOptions } from '@wrenyard/agent-client';
export async function inspectGrok(options?: InspectOptions): Promise<ClientStatus> {
    const env = options?.env ?? process.env;
    if (!options?.executable?.trim()) {
        const home = env.HOME || env.USERPROFILE || homedir();
        const local = join(home, '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
        if (existsSync(local))
            return findExecutable(['grok'], { ...options, executable: local });
    }
    return findExecutable(['grok'], options);
}
