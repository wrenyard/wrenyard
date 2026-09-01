import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  projectConversationHistory,
  projectConversationModels,
} from '../src/dsh-conversation-client.js';

function entry(type: string, seq: number, data: Record<string, unknown>) {
  return { event: { type, seq, time: 1_700_000_000_000 + seq, data } };
}

test('conversation projection keeps user and finalized assistant content without duplicate chunks', () => {
  const items = projectConversationHistory([
    entry('user/message', 1, {
      role: 'user',
      source: { kind: 'user', rpcId: 'rpc-1' },
      content: [{ type: 'text', text: '请检查 workspace' }],
    }),
    entry('assistant/chunk', 2, { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: '先看配置' } }),
    entry('assistant/chunk', 3, { turn: 1, step: 1, chunk: { type: 'text-delta', text: '正在检查' } }),
    entry('assistant/message', 4, {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'reasoning', text: '先看配置' }, { type: 'text', text: '检查完成' }] },
    }),
  ]);

  assert.deepEqual(items.map((item) => ({ kind: item.kind, text: item.text, reasoning: item.reasoning })), [
    { kind: 'user', text: '请检查 workspace', reasoning: undefined },
    { kind: 'assistant', text: '检查完成', reasoning: '先看配置' },
  ]);
});

test('conversation projection exposes an unfinished stream and tool state', () => {
  const items = projectConversationHistory([
    entry('assistant/chunk', 1, { turn: 2, step: 1, chunk: { type: 'text-delta', text: '我来' } }),
    entry('assistant/chunk', 2, { turn: 2, step: 1, chunk: { type: 'text-delta', text: '处理' } }),
    entry('tool/call', 3, { callId: 'call-1', name: 'Read', arguments: '{"path":"README.md"}' }),
    entry('tool/result', 4, {
      message: {
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [], isError: false }],
      },
    }),
  ]);

  assert.equal(items[0].kind, 'assistant');
  assert.equal(items[0].text, '我来处理');
  assert.equal(items[0].running, true);
  assert.equal(items[1].kind, 'tool');
  assert.equal(items[1].toolName, 'Read');
  assert.equal(items[1].toolState, 'done');
});

test('conversation projection keeps every assistant step and tool in one turn group', () => {
  const items = projectConversationHistory([
    entry('user/message', 1, {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '检查后告诉我结果' }],
    }),
    entry('assistant/message', 2, {
      turn: 7,
      step: 1,
      message: { content: [{ type: 'text', text: '先检查一下。' }] },
    }),
    entry('tool/call', 3, { callId: 'call-7', name: 'project_describe', arguments: '{}' }),
    entry('tool/result', 4, {
      message: {
        source: { kind: 'tool', callId: 'call-7' },
        content: [{ type: 'tool-result', toolCallId: 'call-7', content: [], isError: false }],
      },
    }),
    entry('assistant/message', 5, {
      turn: 7,
      step: 2,
      message: { content: [{ type: 'text', text: '检查完成。' }] },
    }),
  ]);

  assert.deepEqual(items.map((item) => ({ kind: item.kind, turnId: item.turnId })), [
    { kind: 'user', turnId: undefined },
    { kind: 'assistant', turnId: 'turn-7' },
    { kind: 'tool', turnId: 'turn-7' },
    { kind: 'assistant', turnId: 'turn-7' },
  ]);
});

test('conversation projection keeps a synthetic turn stable when DSH omits turn numbers', () => {
  const items = projectConversationHistory([
    entry('user/message', 1, {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '继续' }],
    }),
    entry('assistant/chunk', 2, { step: 1, chunk: { type: 'text-delta', text: '正在' } }),
    entry('assistant/chunk', 3, { step: 1, chunk: { type: 'text-delta', text: '处理' } }),
    entry('assistant/message', 4, {
      step: 1,
      message: { content: [{ type: 'text', text: '处理完成。' }] },
    }),
    entry('tool/call', 5, { callId: 'call-synthetic', name: 'Read', arguments: '{}' }),
  ]);

  assert.deepEqual(items.map((item) => ({ kind: item.kind, turnId: item.turnId })), [
    { kind: 'user', turnId: undefined },
    { kind: 'assistant', turnId: 'assistant-2' },
    { kind: 'tool', turnId: 'assistant-2' },
  ]);
});

test('conversation projection hides non-user context messages', () => {
  const items = projectConversationHistory([
    entry('user/message', 1, {
      role: 'user',
      source: { kind: 'plugin' },
      content: [{ type: 'text', text: 'hidden context' }],
    }),
  ]);
  assert.deepEqual(items, []);
});

test('model projection preserves provider groups, current selection and default effort', () => {
  const models = projectConversationModels({
    current: { provider: 'zhipu-coding', model: 'glm-5.3', reasoningEffort: 'high' },
    routable: true,
    groups: [
      {
        id: 'zhipu-coding',
        name: 'GLM Coding',
        models: [
          {
            id: 'glm-5.3',
            name: 'GLM-5.3',
            description: 'General coding model',
            reasoning: { efforts: [], defaultEffort: 'medium' },
          },
          { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' },
        ],
      },
    ],
    failures: [],
  });

  assert.equal(models.status, 'ready');
  assert.equal(models.routable, true);
  assert.deepEqual(models.current, {
    provider: 'zhipu-coding',
    model: 'glm-5.3',
    label: 'GLM 5.3',
    providerLabel: 'GLM Coding',
    advertised: true,
    configured: true,
    reasoningEffort: 'high',
  });
  assert.equal(models.groups[0]?.models[0]?.defaultReasoningEffort, 'medium');
  assert.deepEqual(models.groups[0]?.models.map((model) => model.label), ['GLM 5.3', 'GLM 5.3 Flash']);
});

test('model projection collapses the Claude-oriented Kimi alias and uses product model names', () => {
  const models = projectConversationModels({
    current: { provider: 'kimi-coding', model: 'k3[1m]' },
    routable: true,
    groups: [
      {
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
          { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision' },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
        ],
      },
      {
        id: 'kimi-coding',
        name: 'Kimi Coding',
        models: [
          { id: 'k3', name: 'Kimi K3' },
          { id: 'k3[1m]', name: 'Kimi K3 1M Context' },
        ],
      },
    ],
    failures: [],
  });

  assert.deepEqual(models.groups[0]?.models.map((model) => model.label), [
    'DeepSeek V4 Flash',
    'DeepSeek V4 Flash Vision',
    'DeepSeek V4 Pro',
  ]);
  assert.deepEqual(models.groups[1]?.models.map((model) => ({ id: model.model, label: model.label })), [
    { id: 'k3', label: 'Kimi K3' },
  ]);
  assert.deepEqual(models.current, {
    provider: 'kimi-coding',
    model: 'k3',
    label: 'Kimi K3',
    providerLabel: 'Kimi Coding',
    advertised: true,
    configured: true,
  });
});

test('model projection keeps a routable unadvertised current selection visible', () => {
  const models = projectConversationModels({
    current: { provider: 'legacy-provider', model: 'legacy-model' },
    routable: true,
    groups: [],
    failures: [{ id: 'catalog', name: 'Catalog', message: 'temporarily unavailable' }],
  });

  assert.deepEqual(models.current, {
    provider: 'legacy-provider',
    model: 'legacy-model',
    label: 'legacy-model',
    providerLabel: 'legacy-provider',
    advertised: false,
    configured: true,
  });
  assert.match(models.message ?? '', /Catalog: temporarily unavailable/);
});

test('model projection keeps only configured provider groups and marks an unconfigured current selection', () => {
  // Second argument: canonical product provider ids whose credentials are
  // actually handed to DSH. DSH `deepseek-official` maps to canonical `deepseek`.
  const models = projectConversationModels(
    {
      current: { provider: 'openai', model: 'gpt-5.6-sol' },
      routable: true,
      groups: [
        {
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
        },
        { id: 'kimi-coding', name: 'Kimi Coding', models: [{ id: 'k3', name: 'Kimi K3' }] },
        { id: 'zhipu-coding', name: 'GLM Coding', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] },
        { id: 'openai', name: 'OpenAI API', models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }] },
      ],
      failures: [],
    },
    ['kimi-coding', 'deepseek'],
  );

  assert.deepEqual(
    models.groups.map((group) => group.provider),
    ['deepseek-official', 'kimi-coding'],
  );
  // The picker inserts a disabled "current" option only when the unadvertised
  // current selection is actually configured.
  assert.equal(models.current?.configured, false);
  assert.equal(models.current?.advertised, false);
});

test('model projection rejects malformed DSH directory responses', () => {
  assert.throws(
    () => projectConversationModels({ current: {}, routable: true, groups: [], failures: [] }),
    /current\.provider/,
  );
});
