/**
 * Isolated unit tests for the daemon-facing RuntimeAliasService
 * (services/foreman/lib/daemon/services/runtime-alias-service.mts).
 *
 * Every store instance is pinned to a freshly created mkdtemp directory via an
 * injected XDG_CONFIG_HOME plus an explicit (non-existent) HOME, so no real
 * user configuration files are ever read or written.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import RuntimeAliasStore, { RevisionConflictError } from '../../lib/runtime-aliases/store.mts';
import {
  AliasInvalidTargetError,
  AliasNotFoundError,
  RuntimeAliasService,
} from '../../lib/daemon/services/runtime-alias-service.mts';

interface TestHarness {
  store: RuntimeAliasStore;
  service: RuntimeAliasService;
  root: string;
  configPath: string;
  cleanup(): Promise<void>;
}

async function makeService(): Promise<TestHarness> {
  const root = await mkdtemp(join(tmpdir(), 'wrenyard-runtime-alias-service-'));
  const store = new RuntimeAliasStore({
    env: { XDG_CONFIG_HOME: root },
    home: join(root, 'no-such-home'),
  });
  const service = new RuntimeAliasService(store);
  return {
    store,
    service,
    root,
    configPath: store.configFilePath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function seedAliases(configPath: string, aliases: Record<string, unknown>, revision = 0): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify({ revision, aliases }), 'utf8');
}

test('snapshot sorts usable aliases by name and projects store issues', async () => {
  const { service, configPath, cleanup } = await makeService();
  try {
    await seedAliases(configPath, {
      broken: 'not-valid-run-syntax',
      typed: 42,
      'zebra.last': 'openai/gpt-5.6-sol:codex',
      'apple.fast': 'anthropic-api/claude-sonnet-5:cc',
    });

    const snapshot = await service.snapshot();
    assert.equal(snapshot.revision, 0);
    assert.deepEqual(snapshot.aliases, [
      { name: 'apple.fast', target: 'anthropic-api/claude-sonnet-5:cc' },
      { name: 'zebra.last', target: 'openai/gpt-5.6-sol:codex' },
    ]);
    // Invalid persisted entries stay visible as issues; valid ones stay usable.
    assert.deepEqual(
      snapshot.issues.map((issue) => issue.name).sort(),
      ['broken', 'typed'],
    );
    assert.equal(snapshot.issues[0]?.value, 'not-valid-run-syntax');
    assert.equal(snapshot.issues[1]?.value, 42);
    for (const issue of snapshot.issues) {
      assert.equal(typeof issue.message, 'string');
      assert.notEqual(issue.message.length, 0);
    }
  } finally {
    await cleanup();
  }
});

test('put and remove each return a fresh snapshot', async () => {
  const { service, configPath, cleanup } = await makeService();
  try {
    const putSnapshot = await service.put({
      name: 'web',
      target: 'openai/gpt-5.6-sol:codex',
      expected_revision: 0,
    });
    assert.equal(putSnapshot.revision, 1);
    assert.equal(putSnapshot.config_path, configPath);
    assert.deepEqual(putSnapshot.aliases, [{ name: 'web', target: 'openai/gpt-5.6-sol:codex' }]);

    const removeSnapshot = await service.remove({ name: 'web', expected_revision: 1 });
    assert.equal(removeSnapshot.revision, 2);
    assert.deepEqual(removeSnapshot.aliases, []);
  } finally {
    await cleanup();
  }
});

test('resolve canonicalizes alias and inline target references', async () => {
  const { service, cleanup } = await makeService();
  try {
    const target = 'anthropic-api/claude-sonnet-5:cc';
    await service.put({ name: 'prod', target, expected_revision: 0 });

    const fromAlias = await service.resolve({ kind: 'alias', name: 'prod' });
    assert.deepEqual(fromAlias, { kind: 'alias', name: 'prod', target });

    const inline = await service.resolve({ kind: 'target', target });
    assert.deepEqual(inline, { kind: 'inline', target });

    await assert.rejects(
      service.resolve({ kind: 'target', target: 'nonsense input' }),
      (error: unknown) => error instanceof AliasInvalidTargetError,
    );
  } finally {
    await cleanup();
  }
});

test('an alias update is observed on the next resolve', async () => {
  const { service, cleanup } = await makeService();
  try {
    await service.put({ name: 'gate', target: 'openai/gpt-5.6-sol:codex', expected_revision: 0 });
    assert.equal(
      (await service.resolve({ kind: 'alias', name: 'gate' })).target,
      'openai/gpt-5.6-sol:codex',
    );

    await service.put({
      name: 'gate',
      target: 'anthropic-api/claude-sonnet-5:cc',
      expected_revision: 1,
    });
    assert.equal(
      (await service.resolve({ kind: 'alias', name: 'gate' })).target,
      'anthropic-api/claude-sonnet-5:cc',
    );
  } finally {
    await cleanup();
  }
});

test('deletion becomes terminal for alias resolution', async () => {
  const { service, cleanup } = await makeService();
  try {
    await service.put({ name: 'temp', target: 'openai/gpt-5.6-sol:codex', expected_revision: 0 });
    await service.remove({ name: 'temp', expected_revision: 1 });

    await assert.rejects(
      service.resolve({ kind: 'alias', name: 'temp' }),
      (error: unknown) => error instanceof AliasNotFoundError,
    );
    await assert.rejects(
      service.resolve({ kind: 'alias', name: 'never-defined' }),
      (error: unknown) => error instanceof AliasNotFoundError,
    );
  } finally {
    await cleanup();
  }
});

test('valid persisted aliases survive while invalid entries stay reported', async () => {
  const { service, configPath, cleanup } = await makeService();
  try {
    await seedAliases(configPath, {
      broken: 'not-valid-run-syntax',
      typed: 42,
      good: 'openai/gpt-5.6-sol:codex',
    });

    const before = await service.snapshot();
    assert.deepEqual(before.aliases, [{ name: 'good', target: 'openai/gpt-5.6-sol:codex' }]);
    assert.equal(before.issues.length, 2);

    // The invalid entries are preserved verbatim across a later CAS put.
    const added = await service.put({
      name: 'extra',
      target: 'anthropic-api/claude-sonnet-5:cc',
      expected_revision: 0,
    });
    assert.equal(added.revision, 1);
    assert.deepEqual(added.aliases, [
      { name: 'extra', target: 'anthropic-api/claude-sonnet-5:cc' },
      { name: 'good', target: 'openai/gpt-5.6-sol:codex' },
    ]);
    assert.equal(added.issues.length, 2);

    assert.equal(
      (await service.resolve({ kind: 'alias', name: 'good' })).target,
      'openai/gpt-5.6-sol:codex',
    );
  } finally {
    await cleanup();
  }
});

test('stale expected revisions fail with a typed CAS conflict and no mutation', async () => {
  const { service, configPath, cleanup } = await makeService();
  try {
    await service.put({ name: 'keep', target: 'openai/gpt-5.6-sol:codex', expected_revision: 0 });

    await assert.rejects(
      service.put({ name: 'other', target: 'anthropic-api/claude-sonnet-5:cc', expected_revision: 99 }),
      (error: unknown) =>
        error instanceof RevisionConflictError &&
        error.expectedRevision === 99 &&
        error.actualRevision === 1,
    );
    await assert.rejects(
      service.remove({ name: 'keep', expected_revision: 42 }),
      (error: unknown) => error instanceof RevisionConflictError,
    );

    const snapshot = await service.snapshot();
    assert.equal(snapshot.revision, 1);
    assert.deepEqual(snapshot.aliases, [{ name: 'keep', target: 'openai/gpt-5.6-sol:codex' }]);
  } finally {
    await cleanup();
  }
});

test('snapshot DTOs never expose credentials or provider endpoints', async () => {
  const { service, cleanup } = await makeService();
  try {
    await service.put({ name: 'prod', target: 'anthropic-api/claude-sonnet-5:cc', expected_revision: 0 });
    const snapshot = await service.snapshot();

    // Closed DTO shapes: exactly the documented top-level and per-entry keys.
    assert.deepEqual(Object.keys(snapshot).sort(), ['aliases', 'config_path', 'issues', 'revision']);
    for (const entry of snapshot.aliases) {
      assert.deepEqual(Object.keys(entry).sort(), ['name', 'target']);
    }
    for (const issue of snapshot.issues) {
      for (const key of Object.keys(issue)) {
        assert(['name', 'value', 'message'].includes(key));
      }
    }

    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /:\/\//);
    assert.doesNotMatch(serialized, /api[-_]?key|authorization|bearer|sk-[A-Za-z0-9]+/i);
  } finally {
    await cleanup();
  }
});
