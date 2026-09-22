import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltinCatalog } from '../../index.ts';
import { resolveCodeBuddyProductModelId } from '../models.ts';

const REQUIRED_OFFERINGS = [
  'deepseek-v4.1-flash',
  'hy4-preview',
  'hy3',
  'minimax-m3',
  'kimi-k3',
  'glm-5.3',
  'glm-5.3-flash',
] as const;

test('CodeBuddy product ids match the mainstream registry or are ignored', () => {
  assert.equal(resolveCodeBuddyProductModelId('hy3-ioa'), 'hunyuan-hy3');
  assert.equal(resolveCodeBuddyProductModelId('hy4-preview'), 'hunyuan-hy4-preview');
  assert.equal(resolveCodeBuddyProductModelId('gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(resolveCodeBuddyProductModelId('kimi-k3-ioa'), 'kimi-k3');
  assert.equal(resolveCodeBuddyProductModelId('minimax-m2.7-ioa'), undefined);
  assert.equal(resolveCodeBuddyProductModelId('MiniMax-M2.7'), undefined);
  assert.equal(resolveCodeBuddyProductModelId('claude-haiku-4.5'), 'claude-haiku-4-5');
  assert.equal(resolveCodeBuddyProductModelId('MiniMax-M3'), 'minimax-m3');
  assert.equal(resolveCodeBuddyProductModelId('echo'), undefined);
  assert.equal(resolveCodeBuddyProductModelId('glm-4.7-ioa'), undefined);
  assert.equal(resolveCodeBuddyProductModelId('glm-5.2'), undefined);
  assert.equal(resolveCodeBuddyProductModelId('glm-5.2-ioa'), undefined);
  assert.equal(resolveCodeBuddyProductModelId('glm-5.2-internal-ioa'), undefined);
  assert.equal(resolveCodeBuddyProductModelId('kimi-k2.6'), undefined);
  assert.equal(resolveCodeBuddyProductModelId('kimi-k2.6-ioa'), undefined);
  assert.equal(resolveCodeBuddyProductModelId('gpt-5.4'), undefined);
  assert.equal(resolveCodeBuddyProductModelId('gpt-5.4-ioa'), undefined);
  assert.equal(resolveCodeBuddyProductModelId('gpt-5.5'), undefined);
  assert.equal(resolveCodeBuddyProductModelId('gpt-5.5-ioa'), undefined);
  assert.equal(resolveCodeBuddyProductModelId('claude-fable-5'), undefined);
  assert.equal(resolveCodeBuddyProductModelId('deepseek-v4-flash-ioa'), 'deepseek-v4.1-flash');
  assert.equal(resolveCodeBuddyProductModelId('deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(resolveCodeBuddyProductModelId('deepseek-v4-pro-ioa'), 'deepseek-v4-pro');
  assert.equal(resolveCodeBuddyProductModelId('claude-sonnet-5-1m'), 'claude-sonnet-5');
  assert.equal(resolveCodeBuddyProductModelId('claude-sonnet-5-1m-ioa'), 'claude-sonnet-5');
  assert.equal(resolveCodeBuddyProductModelId('claude-sonnet-5'), undefined);
  assert.equal(resolveCodeBuddyProductModelId('claude-opus-5-1m'), 'claude-opus-5');
  assert.equal(resolveCodeBuddyProductModelId('claude-opus-5-1m-ioa'), 'claude-opus-5');
  assert.equal(resolveCodeBuddyProductModelId('claude-opus-5'), undefined);
  assert.equal(resolveCodeBuddyProductModelId('hunyuan-image-v3.0-ioa'), undefined);
});

test('CodeBuddy offerings are mainstream JSON matches plus CUSTOM leftovers', () => {
  const provider = createBuiltinCatalog().provider('codebuddy')!;
  const ids = provider.models.map((entry) => entry.id);
  for (const id of REQUIRED_OFFERINGS) {
    assert.ok(ids.includes(id), `missing required offering ${id}`);
  }
  assert.equal(provider.models.find((entry) => entry.id === 'hy3')?.canonicalModel, undefined);
  assert.deepEqual(provider.models.find((entry) => entry.id === 'hy4-preview')?.canonicalModel, {
    id: 'hunyuan-hy4-preview',
    displayName: 'HY4 Preview',
  });
  assert.equal(provider.models.find((entry) => entry.id === 'deepseek-v4.1-flash')?.canonicalModel, undefined);
  for (const banned of [
    'echo',
    'glm-4.7',
    'glm-5.2',
    'kimi-k2.6',
    'gpt-5.4',
    'gpt-5.5',
    'claude-fable-5',
    'deepseek-v4-flash',
    'default-model',
  ]) {
    assert.ok(!ids.includes(banned), `${banned} leaked into CodeBuddy offerings`);
  }
});
