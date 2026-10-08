import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  decodeFirstRequest,
  firstRequestAfterSend,
  initialReasoningEffort,
  nearestReasoningEffort,
  normalizeReasoningEffort,
  readFirstRequest,
  retainReasoningEffort,
  writeFirstRequest,
  type FirstRequestStorage,
} from '../src/renderer/pages/session/state/reasoning-effort.js';

/** In-memory `Storage` double for the client-local first-request record. */
function fakeStorage(seed: Record<string, string> = {}): FirstRequestStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

test('nearest selection picks the nearest supported level at or above the request', () => {
  assert.equal(nearestReasoningEffort('low', ['none', 'low', 'medium', 'high', 'xhigh', 'max']), 'low');
  assert.equal(nearestReasoningEffort('medium', ['none', 'medium', 'max']), 'medium');
  assert.equal(nearestReasoningEffort('medium', ['none', 'low', 'high']), 'high');
  assert.equal(nearestReasoningEffort('high', ['none', 'low', 'medium']), 'medium');
});

test('nearest selection falls back to the highest supported level above the ladder top', () => {
  assert.equal(nearestReasoningEffort('max', ['none', 'low', 'medium']), 'medium');
  assert.equal(nearestReasoningEffort('xhigh', ['low', 'high']), 'high');
});

test('an empty supported list throws; the route-owned list must be non-empty', () => {
  assert.throws(() => nearestReasoningEffort('low', []));
});

test('initial session effort resolves medium nearest-else-highest', () => {
  assert.equal(initialReasoningEffort(['none', 'low', 'medium', 'high', 'xhigh', 'max']), 'medium');
  assert.equal(initialReasoningEffort(['none', 'low', 'max']), 'max');
  assert.equal(initialReasoningEffort(['none', 'high', 'max']), 'high');
});

test('model change retains a still-supported level and otherwise re-resolves', () => {
  assert.equal(retainReasoningEffort('high', ['low', 'medium', 'high']), 'high');
  assert.equal(retainReasoningEffort('high', ['low', 'medium']), 'medium');
  assert.equal(retainReasoningEffort('xhigh', ['none', 'low']), 'low');
});

test('an unusable current effort resolves from the medium feature default', () => {
  assert.equal(retainReasoningEffort('', ['low', 'medium', 'high']), 'medium');
  assert.equal(retainReasoningEffort('bogus', ['low', 'medium', 'high']), 'medium');
  assert.equal(retainReasoningEffort(undefined, ['low', 'high']), 'high');
});

test('normalizeReasoningEffort rejects the retired midium alias and every other non-level token', () => {
  assert.equal(normalizeReasoningEffort('midium'), undefined);
  assert.equal(normalizeReasoningEffort('medium'), 'medium');
  assert.equal(normalizeReasoningEffort('none'), 'none');
  assert.equal(normalizeReasoningEffort(''), undefined);
  assert.equal(normalizeReasoningEffort('ultra'), undefined);
  assert.equal(normalizeReasoningEffort(42), undefined);
});

test('client-local first request is remembered and a later request never overwrites it', () => {
  const storage = fakeStorage();
  const first = { model: 'anthropic/claude-opus-5-5', effort: 'high' as const };

  assert.equal(readFirstRequest(storage), undefined);
  const recorded = firstRequestAfterSend(readFirstRequest(storage), first, false);
  assert.deepEqual(recorded, first);
  writeFirstRequest(recorded!, storage);
  assert.deepEqual(readFirstRequest(storage), first);

  // A later request in the same (already-sent) session must not overwrite it.
  const later = firstRequestAfterSend(
    readFirstRequest(storage),
    { model: 'deepseek/deepseek-v4.1', effort: 'low' },
    true,
  );
  assert.equal(later, undefined);
  assert.deepEqual(readFirstRequest(storage), first);

  // A brand-new session's first request does replace the previous record.
  const next = firstRequestAfterSend(
    readFirstRequest(storage),
    { model: 'deepseek/deepseek-v4.1', effort: 'low' },
    false,
  );
  assert.deepEqual(next, { model: 'deepseek/deepseek-v4.1', effort: 'low' });
});

test('a later request never writes even when no record is stored yet', () => {
  const storage = fakeStorage();
  assert.equal(readFirstRequest(storage), undefined);

  const later = firstRequestAfterSend(
    readFirstRequest(storage),
    { model: 'deepseek/deepseek-v4.1', effort: 'low' },
    true,
  );
  assert.equal(later, undefined);
  assert.equal(readFirstRequest(storage), undefined);
});

test('a malformed or retired persisted record decodes to undefined', () => {
  assert.equal(decodeFirstRequest(''), undefined);
  assert.equal(decodeFirstRequest('not json'), undefined);
  assert.equal(decodeFirstRequest('42'), undefined);
  assert.equal(decodeFirstRequest('{"model":""}'), undefined);
  assert.equal(decodeFirstRequest('{"model":"a/b","effort":"ultra"}'), undefined);
  assert.equal(decodeFirstRequest('{"model":"a/b","effort":"midium"}'), undefined);
  assert.deepEqual(decodeFirstRequest('{"model":"a/b","effort":"high"}'), { model: 'a/b', effort: 'high' });
});

test('no legacy session-default settings or picker default option survives', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const registry = readFileSync(join(here, '..', 'src', 'renderer', 'pages', 'settings', 'model', 'registry.ts'), 'utf8');
  const picker = readFileSync(join(here, '..', 'src', 'renderer', 'components', 'chat', 'model-picker.tsx'), 'utf8');
  assert.equal(registry.includes('session.defaultModel'), false);
  assert.equal(registry.includes('sessionDefaults'), false);
  assert.equal(picker.includes('默认'), false);
});
