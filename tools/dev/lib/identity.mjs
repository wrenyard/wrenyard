import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeCheckout } from './paths.mjs';

const INSTANCE_VERSION = 1;

export function newInstanceId() {
  return randomBytes(12).toString('hex');
}

export function newLaunchId() {
  return randomBytes(8).toString('hex');
}

export function startIdentity(now = () => new Date().toISOString()) {
  return {
    pid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    user: process.env.USERNAME || process.env.USER || undefined,
    startedAt: now(),
    execPath: process.execPath,
  };
}

/**
 * @param {{ checkout: string, platform?: NodeJS.Platform, git?: (args: string[]) => { status: number | null, stdout: string } }} options
 */
export function readGitRevision(options) {
  const run = options.git ?? ((args) => {
    const result = spawnSync('git', ['-C', options.checkout, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    });
    return { status: result.status, stdout: result.stdout ?? '' };
  });
  const head = run(['rev-parse', 'HEAD']);
  if (head.status !== 0) return { revision: 'unknown', dirty: false };
  const revision = head.stdout.trim();
  const porcelain = run(['status', '--porcelain']);
  const dirty = porcelain.status === 0 && porcelain.stdout.trim().length > 0;
  return { revision, dirty };
}

export function formatGitRevision({ revision, dirty }) {
  if (!revision || revision === 'unknown') return 'unknown';
  return dirty ? `${revision} (dirty)` : revision;
}

export function createInstanceRecord(input) {
  return {
    version: INSTANCE_VERSION,
    instanceId: input.instanceId,
    checkout: normalizeCheckout(input.checkout, { platform: input.platform }),
    status: input.status ?? 'preparing',
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    supervisorPid: input.supervisorPid ?? process.pid,
    daemonPid: input.daemonPid ?? null,
    desktopPid: input.desktopPid ?? null,
    startIdentity: input.startIdentity ?? startIdentity(),
    controlEndpoint: input.controlEndpoint,
    currentGeneration: input.currentGeneration ?? null,
    pendingGeneration: input.pendingGeneration ?? null,
    sources: input.sources ?? {},
    paths: input.paths ?? {},
    mode: 'source-development',
  };
}

export function parseInstanceRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.version !== INSTANCE_VERSION) return null;
  if (typeof raw.instanceId !== 'string' || !raw.instanceId) return null;
  if (typeof raw.checkout !== 'string' || !raw.checkout) return null;
  if (typeof raw.controlEndpoint !== 'string' || !raw.controlEndpoint) return null;
  return raw;
}

export function processAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

export function readInstanceFile(path, read = readFileSync) {
  try {
    return parseInstanceRecord(JSON.parse(read(path, 'utf8')));
  } catch {
    return null;
  }
}

export function writeInstanceFile(path, record, write = writeFileSync, mkdir = mkdirSync) {
  mkdir(dirname(path), { recursive: true });
  write(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}
