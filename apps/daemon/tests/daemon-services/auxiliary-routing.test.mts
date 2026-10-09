import assert from 'node:assert/strict';
import test from 'node:test';
import { Catalog, type ModelDefinition, type ProviderDefinition } from '@wrenyard/providers/catalog';
import { createCodeBuddy } from '@wrenyard/providers/codebuddy';
import { createAuxiliarySelector, type AuxiliaryRoutingOptions } from '../../lib/daemon/services/auxiliary-routing.mts';
import type { AutoRoutingQuotaSnapshot } from '../../lib/daemon/services/auto-routing-snapshot-service.mts';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const model = (id: string, overrides: Partial<ModelDefinition> = {}): ModelDefinition => ({
  id, displayName: id, intelligence: 'mid', contextWindow: 131072, capabilities: ['text'],
  reasoningEfforts: ['none', 'low', 'high'], speed: 200, pricing: [0, 1, 1], ...overrides,
});
const provider = (models: ModelDefinition[]): ProviderDefinition => ({
  id: 'fixture', displayName: 'Fixture', credentialResolver: 'managed', models,
  protocols: [{ protocol: 'openai_chat', endpoint: 'https://fixture.invalid', authScheme: 'bearer' }],
  convertReasoningEffort: (_id, effort) => ({ reasoning_effort: effort }),
});
function fixture(models: ModelDefinition[], overrides: Partial<AuxiliaryRoutingOptions> = {}) {
  const catalog = new Catalog(); catalog.registerProvider(provider(models));
  const snapshot: AutoRoutingQuotaSnapshot = { snapshotId: 'fixed', nowMs: NOW, validUntilMs: NOW + 60000, entries: [], hardBlockedProviderIds: [] };
  const options: AuxiliaryRoutingOptions = { catalog,
    quotaSnapshots: { routingSnapshot: async () => ({ snapshot, codeBuddySnapshot: undefined }) },
    runtimeAvailability: async () => ({ providerCredential: 'available', providerLive: 'available', quota: 'unknown', available: true }),
    readSettings: () => ({ routingWeights: { price: 1, speed: 0, quota: 0, intelligence: 0 } }), ...overrides };
  return { options, snapshot, select: createAuxiliarySelector(options) };
}

test('fixed evidence selects deterministically and keeps the ranked order', async () => {
  const { select } = fixture([model('b'), model('a')]);
  const first = await select('reply');
  assert.deepEqual(first, await select('reply'));
  assert.deepEqual(first, [{ model: 'fixture/a', reasoningEffort: 'none' }, { model: 'fixture/b', reasoningEffort: 'none' }]);
});
test('first effort layer beats cheaper enabled-only routes; HY3 none is eligible', async () => {
  const { definition } = createCodeBuddy({ productModels: [{ id: 'hunyuan-hy3' }] });
  const { options } = fixture([model('cheap', { pricing: [0, 0, 0], reasoningEfforts: ['low', 'high'] })]);
  options.catalog.registerProvider(definition);
  assert.deepEqual(await createAuxiliarySelector(options)('title'), [{ model: 'codebuddy/hunyuan-hy3', reasoningEffort: 'none' }]);
});
test('second preference layer wins when none is unsupported', async () => {
  const { select } = fixture([model('high', { reasoningEfforts: ['high'], pricing: [0, 0, 0] }), model('low', { reasoningEfforts: ['low', 'high'] })]);
  assert.deepEqual(await select('reply'), [{ model: 'fixture/low', reasoningEffort: 'low' }]);
});
test('compile prefers routes that support high', async () => {
  const { select } = fixture([model('none-only', { reasoningEfforts: ['none'], pricing: [0, 0, 0] }), model('thinking')]);
  assert.deepEqual(await select('compile'), [{ model: 'fixture/thinking', reasoningEffort: 'high' }]);
});
test('no preferred level supported retains all candidates and resolves nearest level', async () => {
  const { select } = fixture([model('medium', { reasoningEfforts: ['medium', 'high'] }), model('high', { reasoningEfforts: ['high'], pricing: [0, 1, 2] })]);
  assert.deepEqual(await select('memory-search'), [{ model: 'fixture/medium', reasoningEffort: 'medium' }, { model: 'fixture/high', reasoningEffort: 'high' }]);
});
test('hard policy gates apply before preference layering', async () => {
  const { select } = fixture([model('expensive-none', { pricing: [0, 1, 20] }), model('valid-low', { reasoningEfforts: ['low'] }),
    model('small-none', { contextWindow: 8192 }), model('unintelligent-none', { intelligence: 'low' }),
    model('image-only', { capabilities: ['image'] }), model('task-only', { taskOnly: true }), model('restricted', { supportedClients: ['opencode'] })],
    { readSettings: () => ({ maxAutoOutputUsdPerMillion: 2 }) });
  assert.deepEqual(await select('doc-search'), [{ model: 'fixture/valid-low', reasoningEffort: 'low' }]);
});
test('blocked quota, missing credentials and no pool produce role-specific reasons', async () => {
  const f = fixture([model('a')]);
  f.options.quotaSnapshots = { routingSnapshot: async () => ({ snapshot: { ...f.snapshot, entries: [{ providerId: 'fixture', modelId: 'a', quotaPoolIds: ['balance'], requiredQuota: [{ id: 'balance', kind: 'balance', evidence: null, balance: { amount: '0', observedAtMs: NOW, validForMs: 60000 } }] }] }, codeBuddySnapshot: undefined }) };
  const blockedSelect = createAuxiliarySelector(f.options);
  await assert.rejects(blockedSelect('reply'), /reply.*quota_blocked/);
  const missing = fixture([model('a')], { runtimeAvailability: () => ({ providerCredential: 'missing', providerLive: 'unknown', quota: 'unknown', available: false }) });
  await assert.rejects(missing.select('compile'), /compile.*provider not configured/);
  await assert.rejects(fixture([]).select('title'), /title.*no Gateway/);
});
test('each call samples evidence and current weights without selection caching', async () => {
  let speedWeight = false; let snapshots = 0;
  const f = fixture([model('cheap', { speed: 20 }), model('fast', { speed: 400, pricing: [0, 1, 2] })], {
    readSettings: () => ({ routingWeights: { price: speedWeight ? 0 : 1, speed: speedWeight ? 1 : 0, quota: 0, intelligence: 0 } }),
    quotaSnapshots: { routingSnapshot: async () => { snapshots++; return { snapshot: { snapshotId: 'fresh', nowMs: NOW, validUntilMs: NOW + 60000, entries: [], hardBlockedProviderIds: [] }, codeBuddySnapshot: undefined }; } },
  });
  assert.equal((await f.select('title'))[0]!.model, 'fixture/cheap'); speedWeight = true;
  assert.equal((await f.select('title'))[0]!.model, 'fixture/fast'); assert.equal(snapshots, 2);
});
