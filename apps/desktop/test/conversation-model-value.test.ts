import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  conversationModelValue,
  parseConversationModelValue,
} from '../src/renderer/conversation.js';

test('conversation model values round-trip opaque provider and model ids', () => {
  const encoded = conversationModelValue('provider/with:punctuation', 'model\nname');
  assert.deepEqual(parseConversationModelValue(encoded), {
    provider: 'provider/with:punctuation',
    model: 'model\nname',
  });
});

test('conversation model values reject malformed or empty selections', () => {
  assert.equal(parseConversationModelValue('not json'), null);
  assert.equal(parseConversationModelValue(JSON.stringify(['provider'])), null);
  assert.equal(parseConversationModelValue(JSON.stringify(['provider', ''])), null);
});
