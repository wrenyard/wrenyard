import { resolveModelSpeed } from '../src/base/catalog.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILTIN_PROVIDERS,
  createBuiltinCatalog,
  deriveTaskDispatchPlans,
  isBuiltinClientGatewayProviderSupported,
} from '../src/index.ts';
import { builtinModelDisplayName, models } from '@wrenyard/models';

test('GPT-6 Astra carries exact truthful SSOT metadata and is the canonical premium profile target', () => {
  const catalog = createBuiltinCatalog();
  const provider = catalog.provider('chatgpt');
  assert.ok(provider, 'codex provider must exist');
  const astra = provider!.models.find((entry) => entry.id === 'gpt-6-astra');
  assert.ok(astra, 'gpt-6-astra model must exist');
  assert.equal(astra!.intelligence, 'premium');
  assert.deepEqual(astra!.thinkingLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(astra!.pricing, [1, 10, 50]);
  assert.deepEqual(astra!.capabilities, ['text', 'image']);
  const plans = deriveTaskDispatchPlans(catalog);
  assert.equal(plans['chatgpt/gpt-6-astra:codex'].model, 'gpt-6-astra');
  assert.equal(plans['chatgpt/gpt-6-astra:codex'].thinking, 'max');
  assert.equal(plans['chatgpt/gpt-6-astra:codex'].reasoningEffort, 'max');
});

test('built-in display names are hyphen-free, sourced from the SSOT, and canonical-consistent', () => {
  // The display-name SSOT is the only source: every built-in label is
  // hyphen-free, and every registered route resolves to that same label.
  for (const provider of BUILTIN_PROVIDERS) {
    for (const model of provider.models) {
      assert.doesNotMatch(model.displayName, /-/u, `${provider.id}/${model.id} displayName must not contain a hyphen`);
      const officialId = model.canonicalModel?.id ?? model.id;
      assert.equal(
        model.displayName,
        builtinModelDisplayName(officialId),
        `${provider.id}/${model.id} displayName must come from the canonical model definition`,
      );
    }
  }

  // Each route's own displayName agrees with its canonicalModel displayName.
  for (const provider of BUILTIN_PROVIDERS) {
    for (const model of provider.models) {
      if (!model.canonicalModel) continue;
      assert.equal(
        model.displayName,
        model.canonicalModel.displayName,
        `${provider.id}/${model.id} route label must agree with its canonical label`,
      );
    }
  }

  const catalog = createBuiltinCatalog();
  const offering = (provider: string, id: string) =>
    catalog.provider(provider)!.models.find((entry) => entry.id === id)!;
  for (const [provider, id, canonical] of [
    ['kimi-coding', 'k3', 'kimi-k3'],
    ['minimax', 'MiniMax-M3', 'minimax-m3'],
    ['deepseek', 'deepseek-flash', 'deepseek-v4.1-flash'],
    ['tokenhub', 'hy4-preview', 'hunyuan-hy4-preview'],
    ['openrouter', 'inclusionai/ling-3.0-flash-vl:free', 'ling-3.0-flash-vl'],
    ['openrouter', 'qwen/qwen3.8-27b:free', 'qwen3.8-27b'],
    ['opencode-zen', 'nemotron-3-ultra-free', 'nemotron-3-ultra'],
    ['opencode-zen', 'nemotron-3.5-lightning-free', 'nemotron-3.5-lightning'],
    ['anthropic', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
  ] as const) {
    const route = offering(provider, id);
    assert.equal(route.canonicalModel?.id, canonical, `${provider}/${id}`);
    assert.equal(route.displayName, builtinModelDisplayName(canonical));
  }
  assert.equal(catalog.provider('kimi-coding')!.modelAliases?.['kimi-for-coding'], 'kimi-k2.8');
  assert.equal(catalog.provider('cursor')!.modelAliases?.['cursor-grok-4.6-high'], 'grok-4.6');
  assert.equal(catalog.provider('cursor')!.modelAliases?.['grok-4.7-high'], 'grok-4.7');
});

