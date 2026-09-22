import { findExecutable, type ClientStatus, type InspectOptions } from '@wrenyard/agent-client';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function inspectCodex(options?: InspectOptions): Promise<ClientStatus> {
    const status = await findExecutable(['codex'], options);
    if (status.installation.state !== 'missing' || options?.executable || process.platform !== 'win32')
        return status;
    const env = options?.env ?? process.env;
    const localAppData = env.LOCALAPPDATA;
    if (!localAppData) return status;
    // The desktop app bundles Codex in versioned directories without adding it to PATH.
    const root = join(localAppData, 'OpenAI', 'Codex', 'bin');
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const candidates = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
        const executable = join(root, entry.name, 'codex.exe');
        const info = await stat(executable).catch(() => undefined);
        return info?.isFile() ? { executable, modified: info.mtimeMs } : undefined;
    }));
    const ordered = candidates.filter(candidate => candidate !== undefined)
        .sort((left, right) => right.modified - left.modified || left.executable.localeCompare(right.executable));
    for (const candidate of ordered) {
        const installed = await findExecutable(['codex'], { ...options, executable: candidate.executable });
        if (installed.installation.state === 'installed') return installed;
    }
    return status;
}
