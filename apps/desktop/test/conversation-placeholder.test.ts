import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  CONVERSATION_PLACEHOLDERS,
  pickConversationPlaceholder,
} from '../src/renderer/conversation.js';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('conversation placeholders form a varied concise workshop copy deck', () => {
  assert.ok(CONVERSATION_PLACEHOLDERS.length >= 20);
  assert.equal(new Set(CONVERSATION_PLACEHOLDERS).size, CONVERSATION_PLACEHOLDERS.length);
  for (const line of CONVERSATION_PLACEHOLDERS) {
    assert.match(line, /…$/u);
    assert.ok([...line].length >= 6 && [...line].length <= 18, line);
  }
});

test('conversation placeholder picker avoids an immediate repeat', () => {
  const first = pickConversationPlaceholder(undefined, () => 0);
  assert.equal(first, CONVERSATION_PLACEHOLDERS[0]);
  assert.equal(
    pickConversationPlaceholder(first, () => 0),
    CONVERSATION_PLACEHOLDERS[1],
  );
});

test('placeholder rotates only at view entry and after successful conversation creation', async () => {
  const renderer = await readFile(join(desktopRoot, 'src', 'renderer', 'conversation.ts'), 'utf8');
  const constructorBlock = renderer.slice(renderer.indexOf('  constructor('), renderer.indexOf('\n  start(): void'));
  const refreshBlock = renderer.slice(renderer.indexOf('  async refresh('), renderer.indexOf('\n  private render('));
  const renderBlock = renderer.slice(renderer.indexOf('  private render('), renderer.indexOf('\n  private renderModels('));
  assert.match(constructorBlock, /this\.rotateConversationPlaceholder\(\);/u);
  assert.match(
    renderer,
    /this\.render\(await this\.api\.createConversation\(\)\);\s+this\.rotateConversationPlaceholder\(\);\s+this\.input\.focus\(\);/u,
  );
  assert.doesNotMatch(renderBlock, /rotateConversationPlaceholder/u);
  assert.doesNotMatch(refreshBlock, /rotateConversationPlaceholder/u);
});
