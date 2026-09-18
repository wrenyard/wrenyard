import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FOREMAN_PROVIDER_MIGRATION_MARKER,
  hasForemanProviderMigrationMarker,
  hasRuntimeProviderMigrationMarker,
  markForemanProviderMigration,
  markRuntimeProviderMigration,
  migrateForemanChatGPTReferences,
  migrateRuntimeChatGPTReferences,
} from '../lib/config/chatgpt-migration.mts';
import { JsonForemanConfigStore } from '../lib/config/manager.mts';
import RuntimeAliasStore from '../lib/runtime-aliases/store.mts';

test('task settings migration uses real nested fields and preserves clients and prose', () => {
  const record = { tasks: { settings: {
    global: { explicitRuntime: { kind: 'target', target: 'codex/gpt-6-astra:codex' }, dispatch: {
      excludeProviderIds: ['codex', 'openai'],
      excludeModelIds: ['codex/gpt-5.5'], excludeProfileIds: ['codex/gpt-5.6-luna:codex'],
    } },
    byTask: { test: { explicitRuntime: { kind: 'target', target: 'codex/gpt-5.5:codex' } }, alias: { explicitRuntime: { kind: 'alias', name: 'codex' } } },
  } }, clients: { codex: { enabled: true } }, prompt: 'codex/model stays literal' };
  const before = structuredClone(record);
  const result = migrateForemanChatGPTReferences(record);
  assert.equal(result.changed, true);
  assert.deepEqual(record, before);
  assert.equal(result.record.tasks.settings.global.explicitRuntime.target, 'chatgpt/gpt-6-astra:codex');
  assert.deepEqual(result.record.tasks.settings.global.dispatch.excludeProviderIds, ['chatgpt', 'openai']);
  assert.deepEqual(result.record.tasks.settings.global.dispatch.excludeModelIds, ['chatgpt/gpt-5.5']);
  assert.deepEqual(result.record.tasks.settings.global.dispatch.excludeProfileIds, ['chatgpt/gpt-5.6-luna:codex']);
  assert.equal(result.record.tasks.settings.byTask.test.explicitRuntime.target, 'chatgpt/gpt-5.5:codex');
  assert.deepEqual(result.record.clients, before.clients);
  assert.equal(result.record.prompt, before.prompt);
  assert.equal(result.record.tasks.settings.byTask.alias.explicitRuntime.name, 'codex');
  assert.equal(migrateForemanChatGPTReferences(result.record).changed, false);
});

test('runtime provider collisions prefer canonical then standard legacy, preserving client ids', () => {
  for (const providers of [{ codex: 2 }, { chatgpt: 2, codex: 3 }]) {
    const result = migrateRuntimeChatGPTReferences({ providers, policy_max_usage_pct: { codex: 70 }, clients: { codex: true } });
    assert.deepEqual(result.record.providers, { chatgpt: 2 });
    assert.deepEqual(result.record.policy_max_usage_pct, { chatgpt: 70 });
    assert.deepEqual(result.record.clients, { codex: true });
    assert.equal(migrateRuntimeChatGPTReferences(result.record).changed, false);
  }
});

test('renamed provider references migrate exactly once and preserve model/client suffixes', () => {
  const record = { tasks: { settings: { global: {
    explicitRuntime: { kind: 'target', target: 'anthropic-api/claude-sonnet-5:cc' },
    dispatch: {
      excludeProviderIds: ['anthropic-api', 'opencode-native'],
      excludeModelIds: ['anthropic-api/claude-opus-5'],
      excludeProfileIds: ['opencode-native/glm-5.3:oc'],
    },
  } } } };
  const before = structuredClone(record);
  const result = migrateForemanChatGPTReferences(record);
  assert.equal(result.changed, true);
  assert.deepEqual(record, before);
  assert.equal(result.record.tasks.settings.global.explicitRuntime.target, 'anthropic/claude-sonnet-5:cc');
  assert.deepEqual(result.record.tasks.settings.global.dispatch.excludeProviderIds, ['anthropic', 'opencode-zen']);
  assert.deepEqual(result.record.tasks.settings.global.dispatch.excludeModelIds, ['anthropic/claude-opus-5']);
  assert.deepEqual(result.record.tasks.settings.global.dispatch.excludeProfileIds, ['opencode-zen/glm-5.3:oc']);
});

test('legacy subscription anthropic becomes claude-coding once and never chains in a single pass', () => {
  const legacy = { tasks: { settings: { global: {
    explicitRuntime: { kind: 'target', target: 'anthropic/claude-sonnet-5:cc' },
    dispatch: { excludeProviderIds: ['anthropic', 'anthropic-api'] },
  } } } };
  const first = migrateForemanChatGPTReferences(legacy);
  assert.equal(first.changed, true);
  // The legacy subscription id becomes claude-coding; the API id becomes the
  // modern anthropic in the same simultaneous pass and is not chained onward.
  assert.equal(first.record.tasks.settings.global.explicitRuntime.target, 'claude-coding/claude-sonnet-5:cc');
  assert.deepEqual(first.record.tasks.settings.global.dispatch.excludeProviderIds, ['claude-coding', 'anthropic']);
});

test('the persisted marker is what makes migration once-only across reads', () => {
  const modern = { tasks: { settings: { global: {
    explicitRuntime: { kind: 'target', target: 'anthropic/claude-opus-5:cc' },
    dispatch: { excludeProviderIds: ['anthropic'] },
  } } } };
  // Once the document is marked, the store skips the migration entirely, so a
  // canonical anthropic API reference is never re-aliased to claude-coding.
  assert.equal(hasForemanProviderMigrationMarker({ ...modern, providerMigration: FOREMAN_PROVIDER_MIGRATION_MARKER }), true);
  const marked = markForemanProviderMigration(modern);
  assert.equal(marked.changed, true);
  assert.equal((marked.record as Record<string, unknown>).providerMigration, FOREMAN_PROVIDER_MIGRATION_MARKER);
  assert.deepEqual(marked.record.tasks, modern.tasks);
  // Already-marked documents are left byte-identical.
  assert.equal(markForemanProviderMigration(marked.record).changed, false);
  // The runtime alias document has its own underscore-prefixed marker.
  assert.equal(hasRuntimeProviderMigrationMarker(markRuntimeProviderMigration({}).record), true);
});

test('runtime aliases and provider keys migrate without touching subscription client ids', () => {
  const result = migrateRuntimeChatGPTReferences({
    aliases: { prod: 'anthropic-api/claude-sonnet-5:cc', zen: 'opencode-native/glm-5.3:oc', sub: 'anthropic/claude-sonnet-5:cc' },
    providers: { 'anthropic-api': { key: 1 }, anthropic: { key: 2 }, 'claude-coding': { key: 3 } },
    clients: { claude: { enabled: true } },
  });
  assert.equal(result.record.aliases.prod, 'anthropic/claude-sonnet-5:cc');
  assert.equal(result.record.aliases.zen, 'opencode-zen/glm-5.3:oc');
  assert.equal(result.record.aliases.sub, 'claude-coding/claude-sonnet-5:cc');
  // The legacy subscription key becomes claude-coding; the legacy API key
  // becomes anthropic independently of the old subscription entry.
  assert.deepEqual(result.record.providers, { anthropic: { key: 1 }, 'claude-coding': { key: 3 } });
  assert.deepEqual(result.record.clients, { claude: { enabled: true } });
});

test('config and alias stores persist migration once and preserve revision concurrency', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-migration-'));
  try {
    const configPath = join(dir, 'foreman.json');
    await writeFile(configPath, JSON.stringify({ tasks: { settings: { global: { explicitRuntime: { kind: 'target', target: 'codex/gpt-5.5:codex' } } } } }));
    const config = new JsonForemanConfigStore();
    config.read(configPath);
    const once = await readFile(configPath, 'utf8');
    assert.match(once, /chatgpt\/gpt-5.5:codex/);
    config.read(configPath);
    assert.equal(await readFile(configPath, 'utf8'), once);
    const aliasPath = join(dir, 'config.json');
    await writeFile(aliasPath, JSON.stringify({ revision: 2, aliases: { smart: 'codex/gpt-5.5:codex', luna: 'codex/gpt-5.6-luna:codex' }, providers: { codex: {} }, clients: { codex: { enabled: true } } }));
    const store = new RuntimeAliasStore({ configRoot: dir });
    const [a, b] = await Promise.all([store.load(), store.load()]);
    assert.equal(a.revision, 3); assert.equal(b.revision, 3);
    assert.equal(a.aliases.smart, 'chatgpt/gpt-5.5:codex');
    assert.equal(a.aliases.luna, 'chatgpt/gpt-5.6-luna:codex');
    assert.equal((await store.load()).revision, 3);
    await assert.rejects(store.put('smart', 'chatgpt/gpt-6-astra:codex', 2));
    await store.put('smart', 'chatgpt/gpt-6-astra:codex', 3);
    assert.equal((await store.load()).revision, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('foreman config store migrates the legacy subscription id and marks the document once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-identity-'));
  try {
    const configPath = join(dir, 'foreman.json');
    // An unmarked legacy document: the subscription anthropic preference must
    // become claude-coding, not be reinterpreted as the API anthropic provider.
    await writeFile(configPath, JSON.stringify({ tasks: { settings: { global: {
      explicitRuntime: { kind: 'target', target: 'anthropic/claude-sonnet-5:cc' },
      dispatch: { excludeProviderIds: ['anthropic', 'anthropic-api'] },
    } } } }));
    const store = new JsonForemanConfigStore();
    const first = store.read(configPath)!;
    const settings = (first.tasks as any).settings.global;
    assert.equal(settings.explicitRuntime.target, 'claude-coding/claude-sonnet-5:cc');
    assert.deepEqual(settings.dispatch.excludeProviderIds, ['claude-coding', 'anthropic']);
    assert.equal(first.providerMigration, FOREMAN_PROVIDER_MIGRATION_MARKER);
    // Once-only: the persisted document is not rewritten again, so the modern
    // anthropic API id written by the first pass survives later reads.
    const persisted = await readFile(configPath, 'utf8');
    const second = store.read(configPath)!;
    assert.equal(await readFile(configPath, 'utf8'), persisted);
    assert.deepEqual(second, first);
    assert.deepEqual((second.tasks as any).settings.global.dispatch.excludeProviderIds, ['claude-coding', 'anthropic']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runtime alias store migrates legacy subscription ids and marks the document once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-identity-alias-'));
  try {
    const aliasPath = join(dir, 'config.json');
    await writeFile(aliasPath, JSON.stringify({ revision: 0, aliases: { sub: 'anthropic/claude-sonnet-5:cc' } }));
    const store = new RuntimeAliasStore({ configRoot: dir });
    const first = await store.load();
    assert.equal(first.aliases.sub, 'claude-coding/claude-sonnet-5:cc');
    assert.equal(first.revision, 1);
    const persisted = await readFile(aliasPath, 'utf8');
    // Once-only: a later load neither rewrites the document nor bumps revision.
    const second = await store.load();
    assert.equal(await readFile(aliasPath, 'utf8'), persisted);
    assert.equal(second.revision, 1);
    assert.equal(second.aliases.sub, 'claude-coding/claude-sonnet-5:cc');
    assert.match(persisted, /_providerMigration/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a put-written canonical anthropic alias is never re-aliased to the subscription provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'provider-identity-put-'));
  try {
    const store = new RuntimeAliasStore({ configRoot: dir });
    // The caller writes a modern API `anthropic` target through put(); it must
    // survive every later read unchanged, because put() marks the document.
    const written = await store.put('prod', 'anthropic/claude-sonnet-5:cc', 0);
    assert.equal(written.canonical, 'anthropic/claude-sonnet-5:cc');
    const loaded = await store.load();
    assert.equal(loaded.aliases.prod, 'anthropic/claude-sonnet-5:cc');
    assert.equal(loaded.revision, written.revision);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
