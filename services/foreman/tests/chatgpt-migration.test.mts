import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateForemanChatGPTReferences, migrateRuntimeChatGPTReferences } from '../lib/config/chatgpt-migration.mts';
import { JsonForemanConfigStore } from '../lib/config/manager.mts';
import RuntimeAliasStore from '../lib/runtime-aliases/store.mts';

test('task settings migration uses real nested fields and preserves clients and prose', () => {
  const record = { tasks: { settings: {
    global: { explicitRuntime: { kind: 'target', target: 'codex/gpt-6-astra:codex' }, dispatch: {
      excludeProviderIds: ['codex', 'codex-spark', 'openai'],
      excludeModelIds: ['codex/gpt-5.5'], excludeProfileIds: ['codex-spark/gpt-5.3-codex-spark:codex'],
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
  assert.deepEqual(result.record.tasks.settings.global.dispatch.excludeProfileIds, ['chatgpt/gpt-5.3-codex-spark:codex']);
  assert.equal(result.record.tasks.settings.byTask.test.explicitRuntime.target, 'chatgpt/gpt-5.5:codex');
  assert.deepEqual(result.record.clients, before.clients);
  assert.equal(result.record.prompt, before.prompt);
  assert.equal(result.record.tasks.settings.byTask.alias.explicitRuntime.name, 'codex');
  assert.equal(migrateForemanChatGPTReferences(result.record).changed, false);
});

test('runtime provider collisions prefer canonical then standard legacy, preserving client ids', () => {
  for (const providers of [
    { 'codex-spark': 1, codex: 2 }, { codex: 2, 'codex-spark': 1 },
    { 'codex-spark': 1, chatgpt: 2, codex: 3 },
  ]) {
    const result = migrateRuntimeChatGPTReferences({ providers, policy_max_usage_pct: { codex: 70 }, clients: { codex: true } });
    assert.deepEqual(result.record.providers, { chatgpt: 2 });
    assert.deepEqual(result.record.policy_max_usage_pct, { chatgpt: 70 });
    assert.deepEqual(result.record.clients, { codex: true });
    assert.equal(migrateRuntimeChatGPTReferences(result.record).changed, false);
  }
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
    await writeFile(aliasPath, JSON.stringify({ revision: 2, aliases: { smart: 'codex/gpt-5.5:codex', spark: 'codex-spark/gpt-5.3-codex-spark:codex' }, providers: { codex: {} }, clients: { codex: { enabled: true } } }));
    const store = new RuntimeAliasStore({ configRoot: dir });
    const [a, b] = await Promise.all([store.load(), store.load()]);
    assert.equal(a.revision, 3); assert.equal(b.revision, 3);
    assert.equal(a.aliases.smart, 'chatgpt/gpt-5.5:codex');
    assert.equal(a.aliases.spark, 'chatgpt/gpt-5.3-codex-spark:codex');
    assert.equal((await store.load()).revision, 3);
    await assert.rejects(store.put('smart', 'chatgpt/gpt-6-astra:codex', 2));
    await store.put('smart', 'chatgpt/gpt-6-astra:codex', 3);
    assert.equal((await store.load()).revision, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
