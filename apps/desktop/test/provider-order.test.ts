import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  reorderProviders,
  sortProvidersByAvailability,
  swapProviders,
} from '../src/provider-order.js';

test('provider ordering preserves enablement and adds discoveries disabled', () => {
  assert.deepEqual(reorderProviders([
    { id: 'codex', enabled: true },
    { id: 'cursor', enabled: false },
  ], ['cursor', 'anthropic', 'codex']), [
    { id: 'cursor', enabled: false },
    { id: 'anthropic', enabled: false },
    { id: 'codex', enabled: true },
  ]);
});

test('provider ordering migrates legacy xai to spacex-ai without losing enablement or position', () => {
  assert.deepEqual(reorderProviders([
    { id: 'xai', enabled: false },
    { id: 'spacex-ai', enabled: true },
    { id: 'codex', enabled: true },
  ], ['xai', 'codex']), [
    { id: 'spacex-ai', enabled: true },
    { id: 'codex', enabled: true },
  ]);
});

test('provider ordering swaps entries without moving unrelated providers', () => {
  assert.deepEqual(swapProviders([
    { id: 'codex', enabled: true },
    { id: 'anthropic', enabled: false },
    { id: 'cursor', enabled: true },
  ], 'codex', 'cursor').map((entry) => entry.id), ['cursor', 'anthropic', 'codex']);
});

test('available providers lead while user order remains stable inside both sections', () => {
  const sorted = sortProvidersByAvailability([
    { id: 'anthropic', configured: false },
    { id: 'codex', configured: true },
    { id: 'cursor', configured: true },
    { id: 'spacex-ai', configured: false },
  ], [
    { id: 'spacex-ai', enabled: false },
    { id: 'cursor', enabled: true },
    { id: 'anthropic', enabled: false },
    { id: 'codex', enabled: true },
  ]);
  assert.deepEqual(sorted.map((entry) => entry.id), ['cursor', 'codex', 'spacex-ai', 'anthropic']);
});
