import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  intelligenceSelectionFromRow,
  intelligencePatch,
  type TaskIntelligenceSelections,
} from '../src/task-intelligence.js';
import type { TaskSettingsLayer } from '../src/shell-contract.js';

function rowWith(automatic: TaskSettingsLayer['automatic']): { user_task: TaskSettingsLayer } {
  return { user_task: { automatic } };
}

test('intelligencePatch is a no-op when both selections inherit and nothing is overridden', () => {
  const current = { intelligence_min: null, intelligence_expected: null };
  const selected: TaskIntelligenceSelections = { min: 'inherit', expected: 'inherit' };
  assert.deepEqual(intelligencePatch(current, selected), {});
});

test('intelligencePatch sets both leaves when both selections change away from inherited', () => {
  const current = { intelligence_min: null, intelligence_expected: null };
  const selected: TaskIntelligenceSelections = { min: 'high', expected: 'premium' };
  assert.deepEqual(intelligencePatch(current, selected), {
    automatic: { intelligence_min: 'high', intelligence_expected: 'premium' },
  });
});

test('intelligencePatch resets only the changed leaf to null, leaving the other untouched', () => {
  const current = { intelligence_min: 'high', intelligence_expected: 'mid' } as const;
  const selected: TaskIntelligenceSelections = { min: 'inherit', expected: 'mid' };
  assert.deepEqual(intelligencePatch(current, selected), { automatic: { intelligence_min: null } });
});

test('intelligencePatch emits a narrow patch that preserves the unchanged leaf', () => {
  const current = { intelligence_min: 'low', intelligence_expected: 'mid' } as const;
  const selected: TaskIntelligenceSelections = { min: 'low', expected: 'premium' };
  assert.deepEqual(intelligencePatch(current, selected), { automatic: { intelligence_expected: 'premium' } });
});

test('intelligencePatch and intelligenceSelectionFromRow do not mutate their inputs', () => {
  const current = { intelligence_min: 'high', intelligence_expected: 'mid' } as const;
  const currentCopy = JSON.parse(JSON.stringify(current));
  const selected: TaskIntelligenceSelections = { min: 'inherit', expected: 'premium' };
  intelligencePatch(current, selected);
  assert.deepEqual(current, currentCopy);

  const row = rowWith({ intelligence_min: 'high', intelligence_expected: 'mid' });
  const rowCopy = JSON.parse(JSON.stringify(row));
  intelligenceSelectionFromRow(row);
  assert.deepEqual(row, rowCopy);
});

test('intelligenceSelectionFromRow reads the editable user_task layer, not the effective value', () => {
  const row = rowWith({ intelligence_min: 'high', intelligence_expected: undefined });
  assert.deepEqual(intelligenceSelectionFromRow(row), { min: 'high', expected: 'inherit' });
  const empty = rowWith(null);
  assert.deepEqual(intelligenceSelectionFromRow(empty), { min: 'inherit', expected: 'inherit' });
});
