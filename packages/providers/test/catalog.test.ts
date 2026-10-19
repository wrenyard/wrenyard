import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILTIN_PROVIDERS,
  createBuiltinCatalog,
  findProviderQuotaBinding,
} from '../src/index.ts';
import { models, resolveReasoningEffort } from '@wrenyard/models';

test('every built-in route declares a non-empty route-owned reasoning-effort ladder', () => {
  for (const provider of BUILTIN_PROVIDERS) {
    for (const model of provider.models) {
      assert.ok(
        Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0,
        `${provider.id}/${model.id} must declare a non-empty reasoningEfforts ladder`,
      );
    }
  }
});

test('resolveReasoningEffort picks the nearest supported level at or above, else the highest, and rejects an empty set', () => {
  assert.equal(resolveReasoningEffort('medium', ['low', 'high', 'max']), 'high');
  assert.equal(resolveReasoningEffort('xhigh', ['low', 'high', 'max']), 'max');
  assert.equal(resolveReasoningEffort('max', ['low', 'high', 'max']), 'max');
  assert.throws(() => resolveReasoningEffort(undefined as never, ['low', 'high', 'max']), /required/);
  assert.equal(resolveReasoningEffort('none', ['none', 'medium']), 'none');
  assert.throws(() => resolveReasoningEffort('low', []), /must not be empty/);
});

test('Catalog.reasoningEfforts returns a non-empty exact client subset of the route ladder', () => {
  const catalog = createBuiltinCatalog();
  const route = catalog.provider('anthropic')!.models.find((entry) => entry.id === 'claude-opus-5-5')!;
  const supported = catalog.reasoningEfforts('claude', 'anthropic', 'claude-opus-5-5');
  assert.ok(supported.length > 0, 'the client subset must be non-empty');
  for (const effort of supported) {
    assert.ok(route.reasoningEfforts.includes(effort), `${effort} must be a route-owned level`);
  }
});

test('convertReasoningEffort is declared per provider module and is protocol-aware', () => {
  const catalog = createBuiltinCatalog();
  const chatgpt = catalog.provider('chatgpt')!;
  assert.deepEqual(
    chatgpt.convertReasoningEffort('gpt-6-astra', 'high', 'openai_responses'),
    { reasoning: { effort: 'high' } },
  );
  const anthropicProvider = catalog.provider('anthropic')!;
  assert.deepEqual(
    anthropicProvider.convertReasoningEffort('claude-opus-5-5', 'high', 'anthropic_messages'),
    { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
  );
});

test('every non-free openrouter and opencode-zen model binds its provider balance pool', () => {
  for (const provider of BUILTIN_PROVIDERS) {
    if (provider.id !== 'openrouter' && provider.id !== 'opencode-zen') continue;
    for (const model of provider.models) {
      if (model.free) continue;
      assert.deepEqual(
        findProviderQuotaBinding(provider.id, model.id)?.pools.map((pool) => pool.quotaPoolId),
        [`${provider.id}/balance`],
        `${provider.id}/${model.id} must bind its provider balance pool`,
      );
    }
  }
});
