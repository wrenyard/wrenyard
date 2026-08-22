import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ensureProductWorkspaceRegistered,
  resolveProductWorkspace,
  resolveWrenyardConfigPath,
  workspaceStoragePath,
} from '../src/workspace.js';

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workspace-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('resolveWrenyardConfigPath prefers WRENYARD_CONFIG_HOME', () => {
  const path = resolveWrenyardConfigPath({
    WRENYARD_CONFIG_HOME: '/tmp/wrenyard-config-home',
    XDG_CONFIG_HOME: '/tmp/xdg-config',
    HOME: '/tmp/home',
  });
  assert.equal(path, '/tmp/wrenyard-config-home/config.json');
});

test('resolveProductWorkspace prefers WRENYARD_DESKTOP_WORKSPACE over config.json', async () => {
  await withTemp(async (dir) => {
    const override = join(dir, 'override-root');
    const configured = join(dir, 'configured-root');
    await mkdir(override);
    await mkdir(configured);
    const xdg = join(dir, 'xdg');
    await mkdir(join(xdg, 'wrenyard'), { recursive: true });
    await writeFile(
      join(xdg, 'wrenyard', 'config.json'),
      JSON.stringify({ workspace: { root: configured } }),
    );
    const resolved = await resolveProductWorkspace({
      WRENYARD_DESKTOP_WORKSPACE: override,
      XDG_CONFIG_HOME: xdg,
    });
    assert.equal(resolved, await realpath(override));
  });
});

test('resolveProductWorkspace reads workspace.root from Wrenyard config.json', async () => {
  await withTemp(async (dir) => {
    const root = join(dir, 'agent-workspace');
    await mkdir(root);
    const xdg = join(dir, 'xdg');
    await mkdir(join(xdg, 'wrenyard'), { recursive: true });
    await writeFile(
      join(xdg, 'wrenyard', 'config.json'),
      JSON.stringify({ workspace: { root } }),
    );
    const resolved = await resolveProductWorkspace({ XDG_CONFIG_HOME: xdg });
    assert.equal(resolved, await realpath(root));
  });
});

test('resolveProductWorkspace rejects a missing workspace.root', async () => {
  await withTemp(async (dir) => {
    const xdg = join(dir, 'xdg');
    await mkdir(join(xdg, 'wrenyard'), { recursive: true });
    await writeFile(join(xdg, 'wrenyard', 'config.json'), JSON.stringify({ pet: { enabled: true } }));
    await assert.rejects(
      () => resolveProductWorkspace({ XDG_CONFIG_HOME: xdg }),
      /workspace\.root is missing/,
    );
  });
});

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
