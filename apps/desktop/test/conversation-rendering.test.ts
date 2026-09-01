import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  groupConversationItems,
  isMarkdownHorizontalRule,
  parseMarkdownTable,
  shouldFollowConversationTail,
} from '../src/renderer/conversation.js';
import type { ConversationItemSnapshot } from '../src/shell-contract.js';

test('Markdown tables are parsed as headers and body rows', () => {
  assert.deepEqual(
    parseMarkdownTable([
      '| Name | State |',
      '| --- | :---: |',
      '| Desktop | ready |',
      '| Pet | running |',
      '',
    ], 0),
    {
      headers: ['Name', 'State'],
      rows: [['Desktop', 'ready'], ['Pet', 'running']],
      nextIndex: 4,
    },
  );
  assert.equal(parseMarkdownTable(['not | a table', 'plain text'], 0), null);
});

test('Markdown horizontal rules are distinguished from list items', () => {
  assert.equal(isMarkdownHorizontalRule('---'), true);
  assert.equal(isMarkdownHorizontalRule(' * * * '), true);
  assert.equal(isMarkdownHorizontalRule('___'), true);
  assert.equal(isMarkdownHorizontalRule('- item'), false);
});

test('assistant steps and tools from one turn render as one message group', () => {
  const items: ConversationItemSnapshot[] = [
    { id: 'user-1', kind: 'user', text: '检查', time: 1 },
    { id: 'assistant-2', kind: 'assistant', text: '开始', time: 2, turnId: 'turn-1' },
    { id: 'tool-1', kind: 'tool', text: '{}', time: 3, turnId: 'turn-1' },
    { id: 'assistant-4', kind: 'assistant', text: '完成', time: 4, turnId: 'turn-1' },
  ];

  const groups = groupConversationItems(items);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.kind, 'item');
  assert.equal(groups[1]?.kind, 'assistant-turn');
  assert.deepEqual(groups[1]?.items.map((item) => item.id), ['assistant-2', 'tool-1', 'assistant-4']);
});

test('conversation follows the tail only on initial/session navigation or while already pinned', () => {
  assert.equal(shouldFollowConversationTail({ sessionChanged: true, wasPinned: false }), true);
  assert.equal(shouldFollowConversationTail({ sessionChanged: false, wasPinned: true }), true);
  assert.equal(shouldFollowConversationTail({ sessionChanged: false, wasPinned: false }), false);
});
