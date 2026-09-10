import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinRequiresImage, imageCapabilitiesPatch, imageRequiredFromRow } from '../src/task-input-types.js';

type Caps = readonly ('text' | 'image')[];
function row(effective: Caps | null = null, override?: Caps, builtin?: Caps) {
  return {
    builtin: { dispatch: { required_capabilities: builtin } },
    user_task: override === undefined ? {} : { automatic: { required_capabilities: override } },
    effective: { automatic: { required_capabilities: { value: effective } } },
  };
}

test('checkbox follows the effective requirement', () => {
  assert.equal(imageRequiredFromRow(row()), false);
  assert.equal(imageRequiredFromRow(row(['image'])), true);
  assert.equal(imageRequiredFromRow(row(['text'])), false);
});

test('mandatory image stays checked and cannot be cleared', () => {
  const value = row(['image'], ['text'], ['image']);
  assert.equal(builtinRequiresImage(value), true);
  assert.equal(imageRequiredFromRow(value), true);
  assert.deepEqual(imageCapabilitiesPatch(value, {}, false), {});
});

test('unchanged checkboxes do not pin inheritance or rewrite legacy arrays', () => {
  for (const caps of [undefined, [], ['text'], ['image'], ['text', 'image']] as const) {
    const value = row(caps ?? null, caps);
    assert.deepEqual(imageCapabilitiesPatch(value, {}, imageRequiredFromRow(value)), {});
  }
  assert.deepEqual(imageCapabilitiesPatch(row(['image']), { automatic: { required_capabilities: ['image'] } }, true), {});
});

test('a changed checkbox sets an image override or masks global image requirements', () => {
  assert.deepEqual(imageCapabilitiesPatch(row(), {}, true), { automatic: { required_capabilities: ['image'] } });
  assert.deepEqual(imageCapabilitiesPatch(row(['image']), { automatic: { required_capabilities: ['image'] } }, false), { automatic: { required_capabilities: ['text'] } });
});

test('returning to inherited state clears only the input override', () => {
  assert.deepEqual(imageCapabilitiesPatch(row(['image'], ['image']), {}, false), { automatic: { required_capabilities: null } });
  assert.deepEqual(imageCapabilitiesPatch(row(['text'], ['text']), { automatic: { required_capabilities: ['image'] } }, true), { automatic: { required_capabilities: null } });
});

test('patch calculation does not mutate other settings', () => {
  const value = { ...row(), user_task: { automatic: { minimum_tps: 70 } } };
  const before = structuredClone(value);
  assert.deepEqual(imageCapabilitiesPatch(value, {}, true), { automatic: { required_capabilities: ['image'] } });
  assert.deepEqual(value, before);
});
