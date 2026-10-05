import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodeBuddyModels, resolveCodeBuddyProductModelId } from '../models.ts';
import type { CodeBuddyProductModelEntry } from '../product.ts';

const entries = (...ids: string[]): CodeBuddyProductModelEntry[] => ids.map((id) => ({ id }));

test('CodeBuddy product ids match the mainstream registry or are ignored', () => {
  assert.equal(resolveCodeBuddyProductModelId('hy3-ioa'), 'hunyuan-hy3');
  assert.equal(resolveCodeBuddyProductModelId('hy4-preview'), 'hunyuan-hy4-preview');
  assert.equal(resolveCodeBuddyProductModelId('gpt-6-sol'), 'gpt-6-sol');
  assert.equal(resolveCodeBuddyProductModelId('gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(resolveCodeBuddyProductModelId('kimi-k3-ioa'), 'kimi-k3');
  assert.equal(resolveCodeBuddyProductModelId('claude-haiku-4.5'), 'claude-haiku-4-5');
  assert.equal(resolveCodeBuddyProductModelId('deepseek-v4-flash-ioa'), 'deepseek-v4.1-flash');
  assert.equal(resolveCodeBuddyProductModelId('deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(resolveCodeBuddyProductModelId('deepseek-v4-pro-ioa'), 'deepseek-v4-pro');
  assert.equal(resolveCodeBuddyProductModelId('claude-opus-5.5'), 'claude-opus-5-5');
  assert.equal(resolveCodeBuddyProductModelId('claude-sonnet-5.5'), 'claude-sonnet-5-5');
  for (const ignored of [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'minimax-m2.7-ioa',
    'MiniMax-M2.7',
    'MiniMax-M3',
    'echo',
    'glm-4.7-ioa',
    'glm-5.2',
    'glm-5.2-ioa',
    'glm-5.2-internal-ioa',
    'kimi-k2.6',
    'kimi-k2.6-ioa',
    'gpt-5.4',
    'gpt-5.4-ioa',
    'gpt-5.5',
    'gpt-5.5-ioa',
    'claude-fable-5',
    'hunyuan-image-v3.0-ioa',
  ]) {
    assert.equal(resolveCodeBuddyProductModelId(ignored), undefined, ignored);
  }
});

test('retired Claude generation-5 rows never become offerings', () => {
  const built = createCodeBuddyModels(entries(
    'claude-opus-5',
    'claude-opus-5-1m',
    'claude-opus-5-1m-ioa',
    'claude-sonnet-5',
    'claude-sonnet-5-1m',
    'claude-sonnet-5-1m-ioa',
  ));
  const ids = new Set(built.definition.models.map((entry) => entry.id));
  assert.ok(!ids.has('claude-opus-5'));
  assert.ok(!ids.has('claude-sonnet-5'));
  assert.ok(!('claude-opus-5' in built.upstreamModels));
  assert.ok(!('claude-sonnet-5' in built.upstreamModels));
  // An old 5 id is never aliased forward onto the 5.5 generation.
  assert.equal(built.definition.modelAliases?.['claude-opus-5'], undefined);
  assert.equal(built.definition.modelAliases?.['claude-sonnet-5'], undefined);
});

test('historical old-5 spellings canonicalize without being offered', () => {
  const history: readonly (readonly [string, string])[] = [
    ['claude-opus-5', 'claude-opus-5'],
    ['claude-opus-5-1m', 'claude-opus-5'],
    ['claude-opus-5-1m-ioa', 'claude-opus-5'],
    ['claude-sonnet-5', 'claude-sonnet-5'],
    ['claude-sonnet-5-1m', 'claude-sonnet-5'],
    ['claude-sonnet-5-1m-ioa', 'claude-sonnet-5'],
  ];
  for (const [observed, canonical] of history) {
    assert.equal(resolveCodeBuddyProductModelId(observed), canonical, observed);
  }
});

test('5.5 offerings come only from an actual product row', () => {
  const withRows = createCodeBuddyModels(entries('claude-opus-5.5', 'claude-sonnet-5.5'));
  const ids = new Set(withRows.definition.models.map((entry) => entry.id));
  assert.ok(ids.has('claude-opus-5-5'));
  assert.ok(ids.has('claude-sonnet-5-5'));
  assert.equal(withRows.upstreamModels['claude-opus-5-5'], 'claude-opus-5.5');
  assert.equal(withRows.upstreamModels['claude-sonnet-5-5'], 'claude-sonnet-5.5');

  const withoutRows = createCodeBuddyModels(entries('deepseek-v4-pro', 'claude-haiku-4.5'));
  const absent = withoutRows.definition.models.map((entry) => entry.id);
  assert.ok(absent.includes('deepseek-v4-pro'));
  assert.ok(absent.includes('claude-haiku-4-5'));
  assert.ok(!absent.some((id) => id.startsWith('claude-opus-5') || id.startsWith('claude-sonnet-5')));
});

test('a snapshot with no Claude 5 rows fabricates no offerings', () => {
  const empty = createCodeBuddyModels([]);
  assert.deepEqual(empty.definition.models, []);
  assert.deepEqual(empty.upstreamModels, {});
  assert.ok(!('claude-opus-5-5' in empty.upstreamModels));
  assert.ok(!('claude-sonnet-5-5' in empty.upstreamModels));
});

test('GPT 5.6 rows are ignored while GPT 6 Sol and 6.1 Sol are offered side by side', () => {
  const built = createCodeBuddyModels(entries('gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'));
  assert.deepEqual(built.definition.models.map((entry) => entry.id), ['gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna']);
});
