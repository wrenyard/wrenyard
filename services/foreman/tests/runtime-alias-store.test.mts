/**
 * Isolated unit tests for the daemon-owned runtime alias store
 * (services/foreman/lib/runtime-aliases/store.mts).
 *
 * Every store instance is pinned to a freshly created mkdtemp directory via
 * an injected XDG_CONFIG_HOME plus an explicit (non-existent) HOME, so no
 * real user configuration files are ever read or written.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PUBLIC_CLIENT_KEYS } from '@wrenyard/catalog';

import RuntimeAliasStore, {
  AliasValidationError,
  MalformedStoreError,
  RevisionConflictError,
} from '../lib/runtime-aliases/store.mts';

interface TestHarness {
  store: RuntimeAliasStore;
  root: string;
  configPath: string;
  cleanup(): Promise<void>;
}

async function makeStore(): Promise<TestHarness> {
  const root = await mkdtemp(join(tmpdir(), 'wrenyard-runtime-aliases-'));
  const store = new RuntimeAliasStore({
    env: { XDG_CONFIG_HOME: root },
    home: join(root, 'no-such-home'),
  });
  return {
    store,
    root,
    configPath: store.configFilePath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('absent file loads as revision 0 with no aliases and no issues', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const snapshot = await store.load();
    assert.equal(snapshot.exists, false);
    assert.equal(snapshot.revision, 0);
    assert.deepEqual(snapshot.aliases, {});
    assert.deepEqual(snapshot.issues, []);
    assert.deepEqual(await store.list(), {});
  } finally {
    await cleanup();
  }
});

test('first put creates a 0700 dir and a 0600 file holding the canonical target', async () => {
  const { store, configPath, cleanup } = await makeStore();
  try {
    const target = 'anthropic-api/claude-sonnet-5:cc';
    const result = await store.put('prod', target);
    assert.equal(result.canonical, target);
    assert.equal(result.revision, 1);

    if (process.platform !== 'win32') {
      const fileMode = (await stat(configPath)).mode & 0o777;
      const dirMode = (await stat(dirname(configPath))).mode & 0o777;
      assert.equal(fileMode, 0o600);
      assert.equal(dirMode, 0o700);
    }

    const snapshot = await store.load();
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.revision, 1);
    assert.deepEqual(snapshot.aliases, { prod: target });
    assert.deepEqual(snapshot.issues, []);

    const raw = JSON.parse(await readFile(configPath, 'utf8')) as {
      revision: number;
      aliases: Record<string, string>;
    };
    assert.equal(raw.revision, 1);
    assert.deepEqual(raw.aliases, { prod: target });
  } finally {
    await cleanup();
  }
});

// Store validation of targets is syntactic only, so pairing a well-formed
// provider/model prefix with each approved public client key exercises
// every key in the shared set.
const PUBLIC_CLIENT_TARGETS = Object.keys(PUBLIC_CLIENT_KEYS).map(
  (publicClientKey) => `anthropic-api/claude-sonnet-5:${publicClientKey}`,
);

test('every public client key is accepted through the shared parser', async () => {
  const { store, cleanup } = await makeStore();
  try {
    let revision = 0;
    for (let i = 0; i < PUBLIC_CLIENT_TARGETS.length; i += 1) {
      const target = PUBLIC_CLIENT_TARGETS[i] as string;
      const result = await store.put(`public-${i}`, target, revision);
      assert.equal(result.revision, revision + 1);
      revision = result.revision;
    }
    const snapshot = await store.load();
    assert.equal(snapshot.revision, PUBLIC_CLIENT_TARGETS.length);
    assert.equal(snapshot.issues.length, 0);
    assert.equal(Object.keys(snapshot.aliases).length, PUBLIC_CLIENT_TARGETS.length);
  } finally {
    await cleanup();
  }
});

test('unrelated top-level fields are preserved across mutations', async () => {
  const { store, configPath, cleanup } = await makeStore();
  try {
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          schemaVersion: 2,
          revision: 1,
          aliases: { existing: 'openai/gpt-5.6-sol:codex' },
          lastSeen: { at: 1234, source: 'daemon' },
          featureFlags: ['a', 'b'],
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = await store.put('added', 'anthropic-api/claude-sonnet-5:cc', 1);
    assert.equal(result.revision, 2);

    const raw = JSON.parse(await readFile(configPath, 'utf8')) as {
      revision: number;
      aliases: Record<string, string>;
      schemaVersion: number;
      lastSeen: { at: number; source: string };
      featureFlags: string[];
    };
    assert.equal(raw.revision, 2);
    assert.equal(raw.schemaVersion, 2);
    assert.deepEqual(raw.lastSeen, { at: 1234, source: 'daemon' });
    assert.deepEqual(raw.featureFlags, ['a', 'b']);
    assert.deepEqual(raw.aliases, {
      existing: 'openai/gpt-5.6-sol:codex',
      added: 'anthropic-api/claude-sonnet-5:cc',
    });
  } finally {
    await cleanup();
  }
});

test('put and remove each increment the persisted revision', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const first = await store.put('one', 'openai/gpt-5.6-sol:codex');
    assert.equal(first.revision, 1);

    const second = await store.put('two', 'anthropic-api/claude-sonnet-5:cc', 1);
    assert.equal(second.revision, 2);

    const removed = await store.remove('one', 2);
    assert.equal(removed.removed, true);
    assert.equal(removed.revision, 3);

    const snapshot = await store.load();
    assert.equal(snapshot.revision, 3);
    assert.deepEqual(snapshot.aliases, { two: 'anthropic-api/claude-sonnet-5:cc' });

    const missing = await store.remove('does-not-exist', 3);
    assert.equal(missing.removed, false);
    assert.equal(missing.revision, 3);
    assert.equal((await store.load()).revision, 3);
  } finally {
    await cleanup();
  }
});

test('stale expectedRevision fails with a typed conflict and no mutation', async () => {
  const { store, configPath, cleanup } = await makeStore();
  try {
    await store.put('keep', 'openai/gpt-5.6-sol:codex'); // revision 1
    const before = await readFile(configPath, 'utf8');

    await assert.rejects(
      store.put('new-alias', 'anthropic-api/claude-sonnet-5:cc', 99),
      (error: unknown) =>
        error instanceof RevisionConflictError &&
        error.expectedRevision === 99 &&
        error.actualRevision === 1,
    );
    await assert.rejects(store.remove('keep', 42), RevisionConflictError);

    assert.equal(await readFile(configPath, 'utf8'), before);
    const snapshot = await store.load();
    assert.equal(snapshot.revision, 1);
    assert.deepEqual(snapshot.aliases, { keep: 'openai/gpt-5.6-sol:codex' });
  } finally {
    await cleanup();
  }
});

test('same-name replacement happens only through an explicit put', async () => {
  const { store, configPath, cleanup } = await makeStore();
  try {
    await store.put('alias', 'openai/gpt-5.6-sol:codex'); // revision 1
    const replaced = await store.put('alias', 'anthropic-api/claude-sonnet-5:cc', 1);
    assert.equal(replaced.revision, 2);

    const snapshot = await store.load();
    assert.deepEqual(snapshot.aliases, { alias: 'anthropic-api/claude-sonnet-5:cc' });

    const raw = JSON.parse(await readFile(configPath, 'utf8')) as {
      aliases: Record<string, string>;
    };
    assert.deepEqual(raw.aliases, { alias: 'anthropic-api/claude-sonnet-5:cc' });
  } finally {
    await cleanup();
  }
});

test('malformed JSON and malformed roots fail closed without rewriting', async () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['invalid JSON', '{ not json'],
    ['array root', JSON.stringify(['a'])],
    ['string root', JSON.stringify('nope')],
    ['null root', JSON.stringify(null)],
    ['string revision', JSON.stringify({ revision: '1', aliases: {} })],
    ['fractional revision', JSON.stringify({ revision: 1.5, aliases: {} })],
    ['negative revision', JSON.stringify({ revision: -1, aliases: {} })],
    ['non-object aliases', JSON.stringify({ revision: 0, aliases: [] })],
  ];
  for (const [label, content] of cases) {
    const { store, configPath, cleanup } = await makeStore();
    try {
      await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
      await writeFile(configPath, content, 'utf8');

      await assert.rejects(
        store.load(),
        (error: unknown) => error instanceof MalformedStoreError,
      );
      await assert.rejects(
        store.put('x', 'openai/gpt-5.6-sol:codex', 0),
        (error: unknown) => error instanceof MalformedStoreError,
      );
      await assert.rejects(
        store.remove('x'),
        (error: unknown) => error instanceof MalformedStoreError,
      );

      assert.equal(await readFile(configPath, 'utf8'), content, label);
    } finally {
      await cleanup();
    }
  }
});

test('an invalid alias entry is reported as an issue while valid aliases stay usable', async () => {
  const { store, configPath, cleanup } = await makeStore();
  try {
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    await writeFile(
      configPath,
      JSON.stringify({
        revision: 0,
        aliases: {
          broken: 'not-valid-run-syntax',
          typed: 42,
          good: 'openai/gpt-5.6-sol:codex',
        },
      }),
      'utf8',
    );

    const snapshot = await store.load();
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.revision, 0);
    assert.deepEqual(snapshot.aliases, { good: 'openai/gpt-5.6-sol:codex' });
    assert.equal(snapshot.issues.length, 2);
    assert.deepEqual(
      snapshot.issues.map((issue) => issue.alias).sort(),
      ['broken', 'typed'],
    );
    assert.equal(snapshot.issues[0].value, 'not-valid-run-syntax');
    assert.equal(snapshot.issues[1].value, 42);

    // Valid aliases stay usable and bad entries are preserved, not rewritten away.
    const added = await store.put('extra', 'anthropic-api/claude-sonnet-5:cc', 0);
    assert.equal(added.revision, 1);

    const after = JSON.parse(await readFile(configPath, 'utf8')) as {
      aliases: Record<string, unknown>;
    };
    assert.equal(after.aliases.broken, 'not-valid-run-syntax');
    assert.equal(after.aliases.typed, 42);
    assert.equal(after.aliases.extra, 'anthropic-api/claude-sonnet-5:cc');

    const reloaded = await store.load();
    assert.equal(reloaded.revision, 1);
    assert.deepEqual(reloaded.aliases, {
      good: 'openai/gpt-5.6-sol:codex',
      extra: 'anthropic-api/claude-sonnet-5:cc',
    });
    assert.equal(reloaded.issues.length, 2);
  } finally {
    await cleanup();
  }
});

test('write/rename failure leaves the original intact and removes temp residue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrenyard-runtime-aliases-'));
  try {
    const env = { XDG_CONFIG_HOME: root };
    const home = join(root, 'no-such-home');
    const working = new RuntimeAliasStore({ env, home });
    await working.put('stable', 'openai/gpt-5.6-sol:codex'); // revision 1
    const before = await readFile(working.configFilePath, 'utf8');
    const dirPath = dirname(working.configFilePath);

    let renameCalls = 0;
    const failing = new RuntimeAliasStore({
      env,
      home,
      fs: {
        rename: async () => {
          renameCalls += 1;
          throw new Error('simulated rename failure');
        },
      },
    });

    await assert.rejects(
      failing.put('other', 'anthropic-api/claude-sonnet-5:cc', 1),
      /simulated rename failure/,
    );
    assert.equal(renameCalls, 1);

    assert.equal(await readFile(working.configFilePath, 'utf8'), before);
    const residue = (await readdir(dirPath)).filter((entry) => entry.includes('.tmp'));
    assert.deepEqual(residue, []);

    const snapshot = await working.load();
    assert.equal(snapshot.revision, 1);
    assert.deepEqual(snapshot.aliases, { stable: 'openai/gpt-5.6-sol:codex' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('put with an invalid alias or target is rejected without writing anything', async () => {
  const { store, configPath, cleanup } = await makeStore();
  try {
    await assert.rejects(store.put('x', 'nonsense input'), AliasValidationError);
    await assert.rejects(store.put('', 'openai/gpt-5.6-sol:codex'), AliasValidationError);
    await assert.rejects(store.remove(''), AliasValidationError);

    await assert.rejects(
      stat(configPath),
      (error: unknown) => (error as { code?: string }).code === 'ENOENT',
    );
    const snapshot = await store.load();
    assert.equal(snapshot.exists, false);
    assert.equal(snapshot.revision, 0);
  } finally {
    await cleanup();
  }
});

test('valid punctuation alias names (lowercase, digit, dot, underscore, hyphen) are accepted on put and remove', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const target = 'openai/gpt-5.6-sol:codex';
    const validNames = ['a1', 'x.y', 'x_y', 'x-y', 'a.b_c-d2', 'web.daemon'];
    let revision = 0;
    for (const name of validNames) {
      const result = await store.put(name, target, revision);
      assert.equal(result.revision, revision + 1);
      revision = result.revision;
    }
    assert.equal((await store.load()).issues.length, 0);

    for (const name of validNames) {
      const result = await store.remove(name, revision);
      assert.equal(result.removed, true);
      assert.equal(result.revision, revision + 1);
      revision = result.revision;
    }
    assert.deepEqual((await store.load()).aliases, {});
  } finally {
    await cleanup();
  }
});

test('empty, whitespace, slash, colon, uppercase, and overlength alias names are rejected on put and remove', async () => {
  const { store, configPath, cleanup } = await makeStore();
  try {
    const invalidNames = [
      '',
      'with space',
      ' leading',
      'trailing ',
      'has/slash',
      'has:colon',
      'Uppercase',
      'aBc',
      'a'.repeat(65),
    ];
    for (const name of invalidNames) {
      await assert.rejects(
        store.put(name, 'openai/gpt-5.6-sol:codex'),
        (error: unknown) => error instanceof AliasValidationError,
      );
      await assert.rejects(
        store.remove(name),
        (error: unknown) => error instanceof AliasValidationError,
      );
    }

    // None of the rejected mutations may write anything.
    await assert.rejects(
      stat(configPath),
      (error: unknown) => (error as { code?: string }).code === 'ENOENT',
    );
    const snapshot = await store.load();
    assert.equal(snapshot.exists, false);
    assert.equal(snapshot.revision, 0);
  } finally {
    await cleanup();
  }
});

test('persisted entries with invalid alias names surface as issues and never become usable', async () => {
  const { store, configPath, cleanup } = await makeStore();
  try {
    const invalidNames = ['', 'has space', 'has/slash', 'has:colon', 'Uppercase', 'x'.repeat(65)];
    const aliases: Record<string, string> = {
      'good.name-1': 'openai/gpt-5.6-sol:codex',
    };
    for (const name of invalidNames) {
      aliases[name] = 'openai/gpt-5.6-sol:codex';
    }
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    await writeFile(configPath, JSON.stringify({ revision: 0, aliases }), 'utf8');

    const snapshot = await store.load();
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.revision, 0);
    // Only the well-formed name is usable; every invalid name is an issue.
    assert.deepEqual(snapshot.aliases, { 'good.name-1': 'openai/gpt-5.6-sol:codex' });
    assert.equal(snapshot.issues.length, invalidNames.length);
    assert.deepEqual(
      snapshot.issues.map((issue) => issue.alias).sort(),
      [...invalidNames].sort(),
    );
    for (const issue of snapshot.issues) {
      assert.equal(typeof issue.problem, 'string');
      assert.notEqual(issue.problem.length, 0);
    }

    // The malformed names are preserved verbatim across a later put.
    const added = await store.put('extra', 'anthropic-api/claude-sonnet-5:cc', 0);
    assert.equal(added.revision, 1);
    const after = JSON.parse(await readFile(configPath, 'utf8')) as {
      aliases: Record<string, unknown>;
    };
    for (const name of invalidNames) {
      assert.equal(after.aliases[name], 'openai/gpt-5.6-sol:codex');
    }
    assert.equal(after.aliases['good.name-1'], 'openai/gpt-5.6-sol:codex');
  } finally {
    await cleanup();
  }
});

test('overlapping same-revision mutations serialize: one commits, one conflicts, and the queue recovers', async () => {
  const { store, configPath, cleanup } = await makeStore();
  try {
    // Both mutations expect revision 0 (absent file) and are fired without
    // awaiting the first, so only queue ordering can linearize them.
    const winnerTarget = 'openai/gpt-5.6-sol:codex';
    const loserTarget = 'anthropic-api/claude-sonnet-5:cc';
    const winner = store.put('contested', winnerTarget, 0);
    const loser = store.put('contested', loserTarget, 0);

    const settled = await Promise.allSettled([winner, loser]);
    const fulfilled = settled.filter((result) => result.status === 'fulfilled');
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    // FIFO queue order is deterministic: the first put commits, the second sees
    // the bumped revision and loses the CAS.
    assert.equal(settled[0].status, 'fulfilled');
    assert.equal((settled[0] as PromiseFulfilledResult<{ revision: number }>).value.revision, 1);
    const conflictReason = rejected[0].reason as RevisionConflictError;
    assert.ok(conflictReason instanceof RevisionConflictError);
    assert.equal(conflictReason.expectedRevision, 0);
    assert.equal(conflictReason.actualRevision, 1);

    // Revision bumped exactly once and only the winning mutation is stored.
    const raw = JSON.parse(await readFile(configPath, 'utf8')) as {
      revision: number;
      aliases: Record<string, string>;
    };
    assert.equal(raw.revision, 1);
    assert.deepEqual(raw.aliases, { contested: winnerTarget });
    const snapshot = await store.load();
    assert.equal(snapshot.revision, 1);
    assert.deepEqual(snapshot.aliases, { contested: winnerTarget });
    assert.equal(snapshot.issues.length, 0);

    // The rejected mutation did not poison the queue: a later mutation works.
    const later = await store.put('after', loserTarget, 1);
    assert.equal(later.revision, 2);
    assert.deepEqual((await store.load()).aliases, {
      contested: winnerTarget,
      after: loserTarget,
    });
  } finally {
    await cleanup();
  }
});
