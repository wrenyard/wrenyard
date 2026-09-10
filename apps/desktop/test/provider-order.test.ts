import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalProviderId,
  normalizeProviderOrder,
  reorderProviders,
  sortProvidersByAvailability,
  swapProviders,
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

test('provider ordering migrates legacy xai to spacex-ai without losing enablement or position', () => {
  assert.deepEqual(reorderProviders([
    { id: 'xai', enabled: false },
    { id: 'spacex-ai', enabled: true },
    { id: 'chatgpt', enabled: true },
  ], ['xai', 'chatgpt']), [
    { id: 'spacex-ai', enabled: true },
    { id: 'chatgpt', enabled: true },
  ]);
});

test('provider ordering swaps entries without moving unrelated providers', () => {
  assert.deepEqual(swapProviders([
    { id: 'chatgpt', enabled: true },
    { id: 'anthropic', enabled: false },
    { id: 'cursor', enabled: true },
  ], 'chatgpt', 'cursor').map((entry) => entry.id), ['cursor', 'anthropic', 'chatgpt']);
});

test('legacy order collapses codex and codex-spark into one stable chatgpt entry', () => {
  assert.equal(canonicalProviderId('codex'), 'chatgpt');
  assert.equal(canonicalProviderId('codex-spark'), 'chatgpt');
  // First occurrence keeps the position; the later legacy duplicate is dropped.
  assert.deepEqual(normalizeProviderOrder([
    { id: 'codex', enabled: true },
    { id: 'cursor', enabled: true },
    { id: 'codex-spark', enabled: false },
    { id: 'anthropic', enabled: true },
  ]), [
    { id: 'chatgpt', enabled: true },
    { id: 'cursor', enabled: true },
    { id: 'anthropic', enabled: true },
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
