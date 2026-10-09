import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { readFirstRequest, retainReasoningEffort, writeFirstRequest } from '../src/renderer/pages/session/state/reasoning-effort.js';

function useLocalStorage(seed: Record<string, string> = {}): Map<string, string> {
  const values = new Map(Object.entries(seed));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } },
  });
  return values;
}

test('a supported level is kept; anything else resolves from medium to the nearest supported level', () => {
  assert.equal(retainReasoningEffort('high', ['low', 'medium', 'high']), 'high');
  assert.equal(retainReasoningEffort('high', ['low', 'medium']), 'medium');
  assert.equal(retainReasoningEffort(undefined, ['none', 'low', 'medium', 'high']), 'medium');
  assert.equal(retainReasoningEffort(undefined, ['none', 'low', 'max']), 'max');
  assert.equal(retainReasoningEffort('midium', ['low', 'medium', 'high']), 'medium');
});

test('the first request round-trips through local storage and malformed records are ignored', () => {
  useLocalStorage();
  assert.equal(readFirstRequest(), undefined);
  writeFirstRequest({ model: 'anthropic/claude-opus-5-5', effort: 'high' });
  assert.deepEqual(readFirstRequest(), { model: 'anthropic/claude-opus-5-5', effort: 'high' });
  for (const raw of ['not json', '42', 'null', '{"model":""}', '{"model":"a/b","effort":"midium"}']) {
    useLocalStorage({ 'session:first-request': raw });
    assert.equal(readFirstRequest(), undefined, raw);
  }
});

test('no legacy session-default settings or picker default option survives', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const registry = readFileSync(join(here, '..', 'src', 'renderer', 'pages', 'settings', 'model', 'registry.ts'), 'utf8');
  const picker = readFileSync(join(here, '..', 'src', 'renderer', 'components', 'chat', 'model-picker.tsx'), 'utf8');
  assert.equal(registry.includes('session.defaultModel'), false);
  assert.equal(registry.includes('sessionDefaults'), false);
  assert.equal(picker.includes('默认'), false);
});
