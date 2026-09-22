import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeProviderId,
  normalizeProviderOrder,
  reorderProviders,
  sortProvidersByAvailability,
} from '../src/provider-order.js';

test('provider ordering migrates legacy enablement away and activates new discoveries', () => {
  assert.deepEqual(reorderProviders([
    { id: 'chatgpt', enabled: true },
    { id: 'cursor', enabled: false },
  ], ['cursor', 'anthropic', 'chatgpt']), [
    { id: 'cursor', enabled: true },
    { id: 'anthropic', enabled: true },
    { id: 'chatgpt', enabled: true },
  ]);
});

test('saved order entries are trimmed and exact duplicates collapse to one row', () => {
  assert.equal(normalizeProviderId('  cursor  '), 'cursor');
  assert.equal(normalizeProviderId('   '), '');
  assert.deepEqual(normalizeProviderOrder([
    { id: '  cursor  ', enabled: true },
    { id: 'cursor', enabled: false },
    { id: '   ', enabled: true },
    { id: 'super-grok', enabled: true },
    { id: 'spacex-ai', enabled: true },
  ]), [
    { id: 'cursor', enabled: true },
    { id: 'super-grok', enabled: true },
    { id: 'spacex-ai', enabled: true },
  ]);
});

test('unknown saved order ids stay inert preferences instead of being remapped', () => {
  // No identity migration: an id that current sources do not report keeps its
  // own row (and is ignored by discovery) rather than collapsing into a peer.
  assert.deepEqual(reorderProviders([
    { id: 'current-provider', enabled: true },
  ], ['legacy-unknown-id', 'current-provider']), [
    { id: 'legacy-unknown-id', enabled: true },
    { id: 'current-provider', enabled: true },
  ]);
});

test('normalized order keeps a stable new chatgpt entry and preservation of unrelated providers', () => {
  assert.deepEqual(normalizeProviderOrder([
    { id: 'chatgpt', enabled: true },
    { id: 'cursor', enabled: false },
    { id: 'chatgpt', enabled: true },
  ]), [
    { id: 'chatgpt', enabled: true },
    { id: 'cursor', enabled: true },
  ]);
});

test('available providers lead while user order remains stable inside both sections', () => {
  const sorted = sortProvidersByAvailability([
    { id: 'anthropic', configured: false },
    { id: 'chatgpt', configured: true },
    { id: 'cursor', configured: true },
    { id: 'spacex-ai', configured: false },
  ], [
    { id: 'spacex-ai', enabled: false },
    { id: 'cursor', enabled: true },
    { id: 'anthropic', enabled: false },
    { id: 'chatgpt', enabled: true },
  ]);
  assert.deepEqual(sorted.map((entry) => entry.id), ['cursor', 'chatgpt', 'spacex-ai', 'anthropic']);
});
