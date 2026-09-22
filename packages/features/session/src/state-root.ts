import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * Storage layout beneath the Wrenyard Desktop state root.
 *
 * The state root itself is owned by the host that starts the service (the
 * daemon resolves the same `userData` identity Electron Desktop uses) and is
 * passed in as `SessionServiceOptions.stateRoot`. These helpers only pin the
 * relative layout inside it, which must stay unchanged so an existing
 * workspace's conversation, DSH home and summary preference all keep being
 * found after the feature was split out of Desktop.
 */

/** DSH home inside the state root; every DSH-owned file lives beneath it. */
export function dshHomePath(stateRoot: string): string {
  return join(stateRoot, 'dsh');
}

/** Product conversation document for one workspace, keyed by its canonical path. */
export function conversationStatePath(stateRoot: string, workspacePath: string): string {
  const digest = createHash('sha256').update(workspacePath).digest('hex');
  return join(stateRoot, 'workspace-state', `${digest}.json`);
}

/** Persisted canonical summary-model preference. */
export function summaryPreferencePath(stateRoot: string): string {
  return join(stateRoot, 'conversation-summary.json');
}
