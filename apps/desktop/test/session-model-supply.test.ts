import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REASONING_EFFORTS } from '@wrenyard/models';
import { BUILTIN_PROVIDERS } from '@wrenyard/providers';
import { selectInferenceMode } from '@wrenyard/session/model-metadata';
import { modelBadges } from '../src/renderer/components/chat/model-picker.js';

/**
 * The shared main-model precedence is the only authority for a row's runtime:
 * one provider/protocol set yields exactly one inference mode.
 */
test('selectInferenceMode picks one runtime by the fixed openai_chat → openai_responses precedence', () => {
  assert.equal(selectInferenceMode(['openai_chat', 'openai_responses']), 'openai_chat');
  assert.equal(selectInferenceMode(['openai_responses', 'openai_chat']), 'openai_chat');
  assert.equal(selectInferenceMode(['openai_responses']), 'openai_responses');
  assert.equal(selectInferenceMode(['anthropic_messages', 'openai_responses']), 'openai_responses');
});

test('selectInferenceMode rejects providers without a supported gateway protocol', () => {
  assert.equal(selectInferenceMode(['anthropic_messages']), undefined);
  assert.equal(selectInferenceMode([]), undefined);
});

test('speed badges use the strict >200 / >100 thresholds', () => {
  assert.deepEqual(modelBadges({ effectiveTps: 100 }), []);
  assert.deepEqual(modelBadges({ effectiveTps: 101 }), [{ kind: 'fast', label: '快速 · 101 TPS' }]);
  assert.deepEqual(modelBadges({ effectiveTps: 200 }), [{ kind: 'fast', label: '快速 · 200 TPS' }]);
  assert.deepEqual(modelBadges({ effectiveTps: 201 }), [{ kind: 'very-fast', label: '极速 · 201 TPS' }]);
});

test('missing or null TPS never invents a speed badge', () => {
  assert.deepEqual(modelBadges({}), []);
  assert.deepEqual(modelBadges({ effectiveTps: null }), []);
});

test('badges render in the fixed order: speed, quota, free', () => {
  assert.deepEqual(
    modelBadges({ effectiveTps: 250, quotaAbundant: true, free: true }),
    [
      { kind: 'very-fast', label: '极速 · 250 TPS' },
      { kind: 'quota', label: '额度充足' },
      { kind: 'free', label: '免费模型' },
    ],
  );
});

test('the free badge appears only for an explicit free flag', () => {
  assert.deepEqual(modelBadges({ free: false }), []);
  assert.deepEqual(modelBadges({}), []);
  assert.deepEqual(modelBadges({ free: true }), [{ kind: 'free', label: '免费模型' }]);
  // Abundant quota and a free flag are independent markers.
  assert.deepEqual(modelBadges({ quotaAbundant: true }), [{ kind: 'quota', label: '额度充足' }]);
});

/**
 * The session model bridge projects a row's effort ladder from route-owned
 * provider metadata, never from the canonical registry, and never sends a model
 * with an undefined effort. A selectable model must therefore declare a
 * non-empty ladder of known levels; a missing one is a supply defect.
 */
test('every route-owned builtin model declares a non-empty known effort ladder', () => {
  const levels = new Set<string>(REASONING_EFFORTS);
  for (const provider of BUILTIN_PROVIDERS) {
    for (const model of provider.models) {
      assert.ok(
        model.reasoningEfforts.length > 0,
        `${provider.id}/${model.id} declares no reasoning efforts`,
      );
      for (const effort of model.reasoningEfforts) {
        assert.ok(
          levels.has(effort),
          `${provider.id}/${model.id} declares unknown effort ${effort}`,
        );
      }
    }
  }
});
