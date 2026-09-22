import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureProductWorkspaceRegistered, workspaceStoragePath } from '../src/workspace-registry.js';

/**
 * DSH workspace-registration cases relocated from the Desktop workspace suite:
 * the durable registry that `startInitialSelection` reads is now owned by this
 * feature, so its coverage lives beside the source.
 */
async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workspace-registry-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('ensureProductWorkspaceRegistered creates a durable Host record', async () => {
  await withTemp(async (dir) => {
    const workspace = join(dir, 'agent-workspace');
    await mkdir(workspace);
    const canonical = await realpath(workspace);
    const dshHome = join(dir, 'dsh');
    const first = await ensureProductWorkspaceRegistered(dshHome, canonical);
    assert.equal(first.created, true);
    const second = await ensureProductWorkspaceRegistered(dshHome, canonical);
    assert.equal(second.created, false);
    assert.equal(second.id, first.id);

    const stored = JSON.parse(await readFile(workspaceStoragePath(dshHome), 'utf8'));
    assert.equal(stored.global.initialized, true);
    assert.deepEqual(stored.global.workspaceIds, [first.id]);
    assert.equal(stored.tables.workspaces[first.id].path, canonical);
    assert.equal(stored.tables.workspaces[first.id].title, 'agent-workspace');
  });
});

test('ensureProductWorkspaceRegistered keeps unrelated workspaces', async () => {
  await withTemp(async (dir) => {
    const product = join(dir, 'agent-workspace');
    const other = join(dir, 'other');
    await mkdir(product);
    await mkdir(other);
    const dshHome = join(dir, 'dsh');
    const otherId = '11111111-1111-1111-1111-111111111111';
    const now = '2026-01-01T00:00:00.000Z';
    await mkdir(join(dshHome, 'storages'), { recursive: true });
    await writeFile(
      workspaceStoragePath(dshHome),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: [otherId], archivedSessionIds: [] },
        tables: {
          workspaces: {
            [otherId]: {
              path: await realpath(other),
              title: 'other',
              sessionIds: ['session-keep'],
              createdAt: now,
              updatedAt: now,
            },
          },
        },
      }),
    );

    const canonical = await realpath(product);
    const result = await ensureProductWorkspaceRegistered(dshHome, canonical);
    const stored = JSON.parse(await readFile(workspaceStoragePath(dshHome), 'utf8'));
    assert.deepEqual(stored.global.workspaceIds, [result.id, otherId]);
    assert.deepEqual(stored.tables.workspaces[otherId].sessionIds, ['session-keep']);
    assert.equal(stored.tables.workspaces[result.id].path, canonical);
  });
});
