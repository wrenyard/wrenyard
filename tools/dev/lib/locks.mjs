import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** `process.kill(pid, 0)`: ESRCH means gone, EPERM still counts as alive. */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) { return error?.code === 'EPERM'; }
}

function readRecord(path, shape) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (!Number.isInteger(raw.pid) || raw.pid <= 0 || typeof raw.startedAt !== 'string') return undefined;
  return shape(raw);
}

/** `dev.lock`: `{ pid, checkout, startedAt }`, written by this supervisor. */
export function readDevLock(path) {
  const record = readRecord(path, (raw) => (typeof raw.checkout === 'string' ? { pid: raw.pid, checkout: raw.checkout, startedAt: raw.startedAt } : undefined));
  return record && processAlive(record.pid) ? record : undefined;
}

/** `daemon.lock`: `{ pid, mode, startedAt }`, written by the daemon. */
export function readDaemonLock(path) {
  const record = readRecord(path, (raw) => (raw.mode === 'source' || raw.mode === 'installed' ? { pid: raw.pid, mode: raw.mode, startedAt: raw.startedAt } : undefined));
  return record && processAlive(record.pid) ? record : undefined;
}

/** Exclusive create; a stale lock (dead pid or unreadable) is removed and retried once. */
export function acquireDevLock(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const holder = readDevLock(path);
    if (holder) throw new Error(`pnpm dev is already running (pid ${holder.pid}, checkout ${holder.checkout}). Stop it with Ctrl+C in its terminal first.`);
    rmSync(path, { force: true });
  }
  throw new Error(`Could not acquire ${path}`);
}

/** Removes the file only while it still records this process. */
export function releaseDevLock(path) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
  if (!raw || raw.pid !== process.pid) return;
  rmSync(path, { force: true });
}
