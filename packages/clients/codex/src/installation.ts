import { findExecutable, type ClientStatus, type InspectOptions } from '@wrenyard/agent-client';
import { spawnProcess } from '@wrenyard/execution';
import type { ChildProcess } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Bounded `--version` probe limits; a slow or oversized banner is unreadable. */
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_MAX_BYTES = 4_096;
const VERSION_PATTERN = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

export async function inspectCodex(options?: InspectOptions): Promise<ClientStatus> {
    const status = await findExecutable(['codex'], options);
    if (status.installation.state !== 'missing' || options?.executable || process.platform !== 'win32')
        return withVersion(status, options);
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
        if (installed.installation.state === 'installed') return withVersion(installed, options);
    }
    return status;
}

/**
 * Attach the real client version by running the resolved executable's
 * `--version`. This is the identity the model-discovery layer keys on; an
 * unreadable or unparseable banner leaves the version absent rather than
 * guessed. No auth.json or credential is read or printed.
 */
async function withVersion(status: ClientStatus, options?: InspectOptions): Promise<ClientStatus> {
    if (status.installation.state !== 'installed') return status;
    const version = await probeVersion(status.installation.executable, options?.env ?? process.env);
    return version ? { ...status, installation: { ...status.installation, version } } : status;
}

/** Run one bounded `--version` probe; resolve with the first version token, or undefined on any failure. */
async function probeVersion(executable: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
    return await new Promise((resolve) => {
        let child: ChildProcess;
        try {
            child = spawnProcess(executable, ['--version'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
        }
        catch {
            resolve(undefined);
            return;
        }
        let output = '';
        let done = false;
        const finish = (value: string | undefined): void => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => {
            child.kill();
            finish(undefined);
        }, VERSION_TIMEOUT_MS);
        child.stdout?.on('data', (chunk: Buffer) => {
            if (output.length >= VERSION_MAX_BYTES)
                return;
            output += chunk.toString('utf8').slice(0, VERSION_MAX_BYTES - output.length);
        });
        child.on('error', () => finish(undefined));
        child.on('close', (code) => {
            if (code !== 0) {
                finish(undefined);
                return;
            }
            const match = VERSION_PATTERN.exec(output);
            finish(match ? match[1] : undefined);
        });
    });
}
