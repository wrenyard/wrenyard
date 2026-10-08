import assert from 'node:assert/strict';
import test from 'node:test';
import { Catalog } from '@wrenyard/providers/catalog';
import { BUILTIN_PROVIDERS, type ProviderRuntime } from '@wrenyard/providers';
import { createCodeBuddyModels } from '../../../../packages/providers/src/codebuddy/models.ts';
import { ProviderService } from '../../../../packages/features/provider/src/service.ts';

test('provider.list and Gateway model list preserve a runtime-only CodeBuddy ladder', async () => {
  const { definition } = createCodeBuddyModels([{ id: 'claude-opus-5-5' }]);
  assert.ok(!BUILTIN_PROVIDERS.find(provider => provider.id === 'codebuddy')!.models.some(model => model.id === 'claude-opus-5-5'));
  const catalog = new Catalog();
  catalog.registerProvider(definition);
  const service = new ProviderService({
    catalog,
    runtime: { credential: async () => ({ kind: 'api-key', value: 'test' }) } as unknown as ProviderRuntime,
    modelStatus: async () => new Map([['codebuddy/claude-opus-5-5', { effectiveTps: 100, quotaAbundant: true }]]),
    localSpeed: () => [],
  });
  const listed = (await service.list()).providers[0].models[0];
  assert.deepEqual(listed.reasoningEfforts, ['low', 'high', 'max']);
  assert.equal(listed.available, true);
  assert.notEqual(listed.reasoningEfforts, definition.models[0].reasoningEfforts);
  assert.deepEqual(catalog.listGatewayModels('openai_chat')[0].reasoningEfforts, listed.reasoningEfforts);
});
