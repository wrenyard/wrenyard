import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildTaskRunSummaryLines,
  groupConversationItems,
  isMarkdownHorizontalRule,
  parseMarkdownTable,
  restoreConversationScrollTop,
  shouldFollowConversationTail,
} from '../src/renderer/conversation.js';
import type { ConversationItemSnapshot, TaskRunSnapshot } from '../src/shell-contract.js';

const rendererSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'conversation.ts'),
  'utf8',
);

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

test('restoreConversationScrollTop keeps an unpinned captured anchor stable and never passes the maximum', () => {
  // Following the tail always lands on the newest content.
  assert.equal(
    restoreConversationScrollTop({ followTail: true, scrollTop: 120, anchorId: 'assistant-5', capturedOffset: 24, anchors: [], maximum: 400 }),
    400,
  );
  // Unpinned: when the same captured anchor moves from offset 24 to 61 the
  // prior scrollTop moves by exactly that 37 delta so the anchor stays put.
  assert.equal(
    restoreConversationScrollTop({
      followTail: false,
      scrollTop: 120,
      anchorId: 'assistant-5',
      capturedOffset: 24,
      anchors: [
        { id: 'assistant-4', offset: 10 },
        { id: 'assistant-5', offset: 61 },
      ],
      maximum: 400,
    }),
    157,
  );
  // Unpinned with no matching anchor: the prior numeric scrollTop is preserved.
  assert.equal(
    restoreConversationScrollTop({
      followTail: false,
      scrollTop: 120,
      anchorId: 'assistant-9',
      capturedOffset: 24,
      anchors: [{ id: 'assistant-5', offset: 61 }],
      maximum: 400,
    }),
    120,
  );
  // The restored scrollTop is clamped to the supplied maximum.
  assert.equal(
    restoreConversationScrollTop({
      followTail: false,
      scrollTop: 380,
      anchorId: 'assistant-5',
      capturedOffset: 24,
      anchors: [{ id: 'assistant-5', offset: 61 }],
      maximum: 400,
    }),
    400,
  );
});

function toLineMap(taskRun: TaskRunSnapshot): Record<string, string> {
  return Object.fromEntries(buildTaskRunSummaryLines(taskRun).map((line) => [line.label, line.value]));
}

test('run_task terminal summary exposes truthful model, token, TPS, cost and selection speed', () => {
  const terminal: TaskRunSnapshot = {
    taskRunId: 'run-1',
    taskId: 'edit',
    resolvedProfile: 'kimi',
    resolvedModel: 'kimi-k2',
    speed: { effectiveTps: 18.5, source: 'local_31d', sampleCount: 31, expectedTpsMet: true },
    usage: {
      completeness: 'complete',
      attemptCount: 1,
      usageEventCount: 2,
      inputTokens: 0,
      outputTokens: 900,
      totalTokens: 900,
      outputTps: 18.75,
      referenceCostUsd: 0.0123,
      referenceCostComplete: true,
    },
  };

  const map = toLineMap(terminal);
  assert.equal(map['模型 / 配置'], 'kimi-k2');
  assert.equal(map['消耗 TOKEN'], '900（输入 0 / 输出 900）');
  // numeric zero input token is preserved, not hidden as missing
  assert.ok(map['消耗 TOKEN'].includes('输入 0'));
  assert.equal(map['实际 TPS'], '18.75');
  assert.equal(map['参考费用（估算）'], '$0.0123');
  assert.equal(map['尝试次数'], '1');
  // selection speed is labeled distinctly from the measured TPS, with its source
  assert.equal(map['选择速度（估算）'], '18.5（来源：本机 31 天）');
});

test('run_task summary shows 未知 for missing values and exposes partial/unavailable', () => {
  const partial: TaskRunSnapshot = {
    taskRunId: 'run-2',
    taskId: 'build',
    usage: {
      completeness: 'partial',
      attemptCount: 3,
      usageEventCount: 1,
      outputTokens: 120,
      totalTokens: 220,
      referenceCostComplete: false,
    },
  };

  const map = toLineMap(partial);
  assert.equal(map['模型 / 配置'], '模型未知');
  assert.equal(map['消耗 TOKEN'], '220（输入 未知 / 输出 120）');
  assert.equal(map['实际 TPS'], '未知');
  assert.equal(map['参考费用（估算）'], '未知');
  assert.equal(map['成本完整性'], '部分');

  const unavailable: TaskRunSnapshot = {
    taskRunId: 'run-3',
    taskId: 'legacy',
    usage: { completeness: 'unavailable', attemptCount: 1, usageEventCount: 0, referenceCostComplete: false },
  };

  const uMap = toLineMap(unavailable);
  assert.equal(uMap['成本完整性'], '不可用');
  assert.equal(uMap['参考费用（估算）'], '未知');
});

test('run_task summary keeps known partial token counts when total is unavailable', () => {
  const partial: TaskRunSnapshot = {
    taskRunId: 'run-partial-known-tokens',
    taskId: 'edit',
    usage: {
      completeness: 'partial',
      attemptCount: 1,
      usageEventCount: 1,
      inputTokens: 1_693_645,
      outputTokens: 21_336,
      referenceCostComplete: false,
    },
  };

  const map = toLineMap(partial);
  assert.equal(map['消耗 TOKEN'], '未知（输入 1693645 / 输出 21336）');
  assert.equal(map['参考费用（估算）'], '未知');
  assert.equal(map['成本完整性'], '部分');
});

test('run_task summary labels catalog-default selection speed', () => {
  const run: TaskRunSnapshot = {
    taskRunId: 'run-4',
    taskId: 'edit',
    speed: { effectiveTps: 7, source: 'catalog_default', sampleCount: null, expectedTpsMet: null },
    usage: { completeness: 'complete', attemptCount: 1, usageEventCount: 1, referenceCostUsd: 0.5, referenceCostComplete: true },
  };

  const map = toLineMap(run);
  assert.equal(map['选择速度（估算）'], '7（来源：目录默认）');
  assert.equal(map['参考费用（估算）'], '$0.5000');
});

test('run_task summary labels provider-override selection speed', () => {
  const run: TaskRunSnapshot = {
    taskRunId: 'run-5',
    taskId: 'edit',
    speed: { effectiveTps: 21.5, source: 'provider_override', sampleCount: null, expectedTpsMet: true },
    usage: { completeness: 'complete', attemptCount: 1, usageEventCount: 1, referenceCostUsd: 0.5, referenceCostComplete: true },
  };

  const map = toLineMap(run);
  assert.equal(map['选择速度（估算）'], '21.5（来源：服务商覆盖）');
});

test('renderer offers pre-session model selection for a ready draft', () => {
  // The obsolete copy that forced users to create a conversation before they
  // could pick a model must be gone from the source.
  assert.equal(rendererSource.includes('新建会话后选择模型'), false, 'obsolete no-session copy must be removed');

  // The picker enable gate must no longer disable solely because no session is
  // selected; a ready draft with advertised options should be selectable.
  assert.equal(
    rendererSource.includes('|| !snapshot.selectedSessionId'),
    false,
    'picker must not be disabled solely for a missing selected session',
  );
});
