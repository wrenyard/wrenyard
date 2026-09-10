import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inputTypeFromRow, inputTypesPatch } from '../src/task-input-types.js';

test('inherited image requirements do not turn an untouched form into a task override', () => {
  assert.equal(inputTypeFromRow({ user_task: {} }), 'inherit');
  assert.deepEqual(inputTypesPatch(undefined, 'inherit'), {});
});

test('image selection adds only input requirements', () => {
  assert.deepEqual(inputTypesPatch(undefined, 'image'), { automatic: { required_capabilities: ['text', 'image'] } });
  assert.deepEqual(inputTypesPatch(['text'], 'image'), { automatic: { required_capabilities: ['text', 'image'] } });
});

test('inherit explicitly deletes the task override even when the inherited value is identical', () => {
  assert.deepEqual(inputTypesPatch(['text', 'image'], 'inherit'), { automatic: { required_capabilities: null } });
  assert.deepEqual(inputTypesPatch(['image'], 'inherit'), { automatic: { required_capabilities: null } });
});

test('legacy image-only and empty arrays stay unchanged when editing unrelated fields', () => {
  assert.equal(inputTypeFromRow({ user_task: { automatic: { required_capabilities: ['image'] } } }), 'image');
  assert.deepEqual(inputTypesPatch(['image'], 'image'), {});
  assert.deepEqual(inputTypesPatch([], 'text'), {});
});

test('text override can replace a user-added image requirement without touching other constraints', () => {
  const row = { user_task: { automatic: { required_capabilities: ['text', 'image'] as const, minimum_tps: 70 } } };
  const before = structuredClone(row);
  const patch = inputTypesPatch(row.user_task.automatic.required_capabilities, 'text');
  assert.deepEqual(patch, { automatic: { required_capabilities: ['text'] } });
  assert.deepEqual(row, before);
  assert.equal('minimum_tps' in patch.automatic!, false);
});
