import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  createProductWorkspace,
  inspectProductWorkspace,
  resolveProductWorkspace,
  resolveWrenyardConfigPath,
  saveProductWorkspace,
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
  assert.equal(path, resolve('/tmp/wrenyard-config-home', 'config.json'));
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

test('inspectProductWorkspace exposes an environment override as the read-only source', async () => {
  await withTemp(async (dir) => {
    const override = join(dir, 'override-root');
    const configured = join(dir, 'configured-root');
    const xdg = join(dir, 'xdg');
    await mkdir(override);
    await mkdir(configured);
    await mkdir(join(xdg, 'wrenyard'), { recursive: true });
    await writeFile(
      join(xdg, 'wrenyard', 'config.json'),
      JSON.stringify({ workspace: { root: configured } }),
    );

    const inspected = await inspectProductWorkspace({
      WRENYARD_DESKTOP_WORKSPACE: override,
      XDG_CONFIG_HOME: xdg,
    });

    assert.deepEqual(inspected, {
      status: 'configured',
      source: 'environment',
      configPath: join(xdg, 'wrenyard', 'config.json'),
      path: await realpath(override),
      readOnly: true,
    });
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

test('inspectProductWorkspace reports missing and invalid configuration without throwing', async () => {
  await withTemp(async (dir) => {
    const xdg = join(dir, 'xdg');
    const missing = await inspectProductWorkspace({ XDG_CONFIG_HOME: xdg });
    assert.equal(missing.status, 'missing');
    assert.equal(missing.source, 'none');
    assert.equal(missing.readOnly, false);

    await mkdir(join(xdg, 'wrenyard'), { recursive: true });
    await writeFile(join(xdg, 'wrenyard', 'config.json'), JSON.stringify({ workspace: { root: join(dir, 'absent') } }));
    const invalid = await inspectProductWorkspace({ XDG_CONFIG_HOME: xdg });
    assert.equal(invalid.status, 'invalid');
    assert.equal(invalid.source, 'user-config');
    assert.equal(invalid.readOnly, false);
    assert.match(invalid.message ?? '', /does not exist/);
  });
});

test('saveProductWorkspace preserves unrelated config and writes the canonical root', async () => {
  await withTemp(async (dir) => {
    const root = join(dir, 'agent-workspace');
    const xdg = join(dir, 'xdg');
    await mkdir(root);
    await mkdir(join(xdg, 'wrenyard'), { recursive: true });
    const configPath = join(xdg, 'wrenyard', 'config.json');
    await writeFile(configPath, JSON.stringify({ pet: { enabled: true }, workspace: { label: 'keep' } }));

    const saved = await saveProductWorkspace(root, { XDG_CONFIG_HOME: xdg });
    assert.equal(saved.status, 'configured');
    assert.equal(saved.source, 'user-config');
    assert.equal(saved.readOnly, false);
    assert.equal(saved.path, await realpath(root));
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(config.pet, { enabled: true });
    assert.deepEqual(config.workspace, { label: 'keep', root: await realpath(root) });
  });
});

test('saveProductWorkspace cannot replace an environment override', async () => {
  await withTemp(async (dir) => {
    const override = join(dir, 'override-root');
    const requested = join(dir, 'requested-root');
    await mkdir(override);
    await mkdir(requested);

    await assert.rejects(
      () => saveProductWorkspace(requested, {
        WRENYARD_DESKTOP_WORKSPACE: override,
        XDG_CONFIG_HOME: join(dir, 'xdg'),
      }),
      /由 WRENYARD_DESKTOP_WORKSPACE 环境变量管理/,
    );
  });
});

test('createProductWorkspace writes the template and preserves unrelated config', async () => {
  await withTemp(async (dir) => {
    const target = join(dir, 'new-workspace');
    const xdg = join(dir, 'xdg');
    await mkdir(join(xdg, 'wrenyard'), { recursive: true });
    const configPath = join(xdg, 'wrenyard', 'config.json');
    await writeFile(configPath, JSON.stringify({ pet: { enabled: true } }));

    const created = await createProductWorkspace(target, { XDG_CONFIG_HOME: xdg });
    assert.equal(created.status, 'configured');
    assert.equal(created.source, 'user-config');
    assert.equal(created.readOnly, false);
    assert.equal(created.path, await realpath(target));

    const runner = JSON.parse(await readFile(join(target, 'workspace.wrws'), 'utf8'));
    assert.equal(runner.version, 1);
    assert.match(await readFile(join(target, 'AGENTS.md'), 'utf8'), /wrenyard project list/);
    assert.match(
      await readFile(join(target, 'instructions', 'tasks.md'), 'utf8'),
      /intelligenceExpected/,
    );
    assert.match(
      await readFile(join(target, 'instructions', 'documents.md'), 'utf8'),
      /spec \/ plan \/ report/,
    );

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(config.pet, { enabled: true });
    assert.equal(config.workspace.root, await realpath(target));
  });
});

test('createProductWorkspace rejects a nonempty destination without changing it', async () => {
  await withTemp(async (dir) => {
    const target = join(dir, 'occupied');
    const xdg = join(dir, 'xdg');
    await mkdir(target);
    const keep = join(target, 'keep.txt');
    await writeFile(keep, 'keep');

    await assert.rejects(
      () => createProductWorkspace(target, { XDG_CONFIG_HOME: xdg }),
      /不是空的/,
    );
    assert.equal(await readFile(keep, 'utf8'), 'keep');
    assert.equal(existsSync(join(target, 'workspace.wrws')), false);
    assert.equal(existsSync(join(xdg, 'wrenyard', 'config.json')), false);
  });
});

test('createProductWorkspace refuses environment overrides and blank paths without writing', async () => {
  await withTemp(async (dir) => {
    const override = join(dir, 'override-root');
    const target = join(dir, 'new-workspace');
    await mkdir(override);
    const xdg = join(dir, 'xdg');

    await assert.rejects(
      () => createProductWorkspace(target, { WRENYARD_DESKTOP_WORKSPACE: override, XDG_CONFIG_HOME: xdg }),
      /由 WRENYARD_DESKTOP_WORKSPACE 环境变量管理/,
    );
    await assert.rejects(
      () => createProductWorkspace('   ', { XDG_CONFIG_HOME: xdg }),
      /请输入 workspace 路径/,
    );
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(join(xdg, 'wrenyard', 'config.json')), false);
  });
});
