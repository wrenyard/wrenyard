/**
 * Read/write `<userData>/update-pending.json`.
 *
 * Written right before the platform applier swaps in a new version and read on
 * the next startup to decide whether that update succeeded or failed.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PENDING_FILENAME = 'update-pending.json';

/** The version pair recorded for an in-flight update. */
export interface PendingUpdate {
  from: string;
  to: string;
}

function pendingPath(userDataPath: string): string {
  return join(userDataPath, PENDING_FILENAME);
}

/** Reads the pending record, or null when it is absent or malformed. */
export function readPendingUpdate(userDataPath: string): PendingUpdate | null {
  const path = pendingPath(userDataPath);
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.from !== 'string' || typeof record.to !== 'string') return null;
    return { from: record.from, to: record.to };
  } catch {
    return null;
  }
}

/** Writes the pending record before any system change is made. */
export function writePendingUpdate(userDataPath: string, pending: PendingUpdate): void {
  mkdirSync(userDataPath, { recursive: true });
  writeFileSync(pendingPath(userDataPath), JSON.stringify(pending, null, 2));
}

/** Deletes the pending record; only called once the outcome is settled. */
export function clearPendingUpdate(userDataPath: string): void {
  try {
    rmSync(pendingPath(userDataPath), { force: true });
  } catch {
    // The pending file is advisory; startup must not fail on cleanup.
  }
}
