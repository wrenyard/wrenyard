import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EMPTY_MODEL_EFFORT_MEMORY,
  MODEL_EFFORTS_STORAGE_KEY,
  defaultModelEffort,
  parseModelEfforts,
  resolveModelEffort,
  withModelEffort,
} from '../apps/desktop/src/renderer/pages/session/state/reasoning-effort-memory.ts';

/** A three-rung ladder shared by the A/B fixtures. */
const LADDER = ['low', 'medium', 'high'];
/** A narrowed ladder: the remembered level `xhigh` is not on it. */
const SLIM_LADDER = ['low', 'high'];

/** Model A remembers `high`, model B remembers `low`. */
function abMemory() {
  return withModelEffort(withModelEffort(EMPTY_MODEL_EFFORT_MEMORY, 'a/opus', 'high'), 'b/astra', 'low');
}

test('the store is a per-model map under the session:model-efforts key', () => {
  assert.equal(MODEL_EFFORTS_STORAGE_KEY, 'session:model-efforts');
  assert.deepEqual(abMemory(), { 'a/opus': 'high', 'b/astra': 'low' });
});

test('A=high, B=low: round-trip switching restores each model its own level', () => {
  let memory = abMemory();
  // A -> B -> A -> B, each switch rewriting only the selected model's key.
  for (const selected of ['b/astra', 'a/opus', 'b/astra', 'a/opus']) {
    const restored = resolveModelEffort(memory, selected, LADDER);
    memory = withModelEffort(memory, selected, restored);
    assert.equal(restored, selected === 'a/opus' ? 'high' : 'low');
  }
  assert.equal(resolveModelEffort(memory, 'a/opus', LADDER), 'high');
  assert.equal(resolveModelEffort(memory, 'b/astra', LADDER), 'low');
});

test('switching a model never writes another model entry', () => {
  const memory = abMemory();
  const afterSwitchToA = withModelEffort(memory, 'a/opus', 'high');
  assert.deepEqual(afterSwitchToA, memory);
  assert.equal(afterSwitchToA['b/astra'], 'low');
  const afterSwitchToB = withModelEffort(afterSwitchToA, 'b/astra', 'low');
  assert.equal(afterSwitchToB['a/opus'], 'high');
  assert.deepEqual(Object.keys(afterSwitchToB).sort(), ['a/opus', 'b/astra']);
});

test('a model with no memory resolves to nothing and keeps its own default', () => {
  const memory = abMemory();
  assert.equal(resolveModelEffort(memory, 'c/fresh', LADDER), undefined);
  // Its own default is the nearest rung at or above medium, never another model's value.
  assert.equal(defaultModelEffort(['low', 'medium', 'high']), 'medium');
  assert.equal(defaultModelEffort(SLIM_LADDER), 'high');
  assert.equal(defaultModelEffort(['none']), 'none');
  // The composition the composer uses: memory wins, otherwise the model's own default.
  assert.equal(resolveModelEffort(memory, 'c/fresh', LADDER) ?? defaultModelEffort(LADDER), 'medium');
});

test('an unsupported remembered level falls back to a valid level without writing other models', () => {
  const memory = withModelEffort(withModelEffort(EMPTY_MODEL_EFFORT_MEMORY, 'a/opus', 'xhigh'), 'b/astra', 'low');
  const resolved = resolveModelEffort(memory, 'a/opus', SLIM_LADDER);
  assert.ok(SLIM_LADDER.includes(resolved));
  assert.equal(resolved, 'high');
  // Resolving neither rewrites the stored memory nor touches another model's key.
  assert.equal(memory['a/opus'], 'xhigh');
  assert.equal(memory['b/astra'], 'low');
});

test('missing, corrupt or unusable storage parses as an empty memory', () => {
  assert.deepEqual(parseModelEfforts(null), EMPTY_MODEL_EFFORT_MEMORY);
  assert.deepEqual(parseModelEfforts(undefined), EMPTY_MODEL_EFFORT_MEMORY);
  assert.deepEqual(parseModelEfforts(''), EMPTY_MODEL_EFFORT_MEMORY);
  assert.deepEqual(parseModelEfforts('{not json'), EMPTY_MODEL_EFFORT_MEMORY);
  assert.deepEqual(parseModelEfforts('[1,2,3]'), EMPTY_MODEL_EFFORT_MEMORY);
  assert.deepEqual(parseModelEfforts('"high"'), EMPTY_MODEL_EFFORT_MEMORY);
  // A valid object keeps its well-formed entries and drops the rest.
  assert.deepEqual(
    parseModelEfforts(JSON.stringify({ 'a/opus': 'high', 'b/astra': 'nonsense', '': 'low' })),
    { 'a/opus': 'high' },
  );
});
