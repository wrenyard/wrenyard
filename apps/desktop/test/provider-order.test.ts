import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalProviderId,
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

test('legacy order collapses codex into one stable chatgpt entry', () => {
  assert.equal(canonicalProviderId('codex'), 'chatgpt');
  // First occurrence keeps the position; the later canonical duplicate is dropped.
  assert.deepEqual(normalizeProviderOrder([
    { id: 'codex', enabled: true },
    { id: 'cursor', enabled: true },
    { id: 'chatgpt', enabled: true },
    { id: 'anthropic', enabled: true },
  ]), [
    { id: 'chatgpt', enabled: true },
    { id: 'cursor', enabled: true },
    { id: 'anthropic', enabled: true },
  ]);
});

test('legacy opencode-native order entry collapses into one opencode-zen entry', () => {
  assert.equal(canonicalProviderId('opencode-native'), 'opencode-zen');
  assert.deepEqual(normalizeProviderOrder([
    { id: 'opencode-native', enabled: true },
    { id: 'cursor', enabled: true },
    { id: 'opencode-zen', enabled: true },
  ]), [
    { id: 'opencode-zen', enabled: true },
    { id: 'cursor', enabled: true },
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
