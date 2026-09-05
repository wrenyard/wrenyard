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

test('model projection preserves the single Gateway provider and public model ids', () => {
  const models = projectConversationModels({
    current: { provider: 'wrenyard', model: 'zhipu-coding/glm-5.3', reasoningEffort: 'high' },
    routable: true,
    groups: [
      {
        id: 'wrenyard',
        name: 'Wrenyard',
        models: [
          {
            id: 'zhipu-coding/glm-5.3',
            name: 'GLM 5.3',
            description: 'General coding model',
            reasoning: { efforts: [], defaultEffort: 'medium' },
          },
          { id: 'zhipu-coding/glm-5.3-flash', name: 'GLM 5.3 Flash' },
        ],
      },
    ],
    failures: [],
  });

  assert.equal(models.status, 'ready');
  assert.equal(models.routable, true);
  assert.deepEqual(models.current, {
    provider: 'wrenyard',
    catalogProvider: 'zhipu-coding',
    model: 'zhipu-coding/glm-5.3',
    label: 'GLM 5.3',
    providerLabel: 'Wrenyard',
    advertised: true,
    configured: true,
    reasoningEffort: 'high',
  });
  assert.equal(models.groups[0]?.models[0]?.defaultReasoningEffort, 'medium');
  assert.deepEqual(models.groups[0]?.models.map((model) => model.label), ['GLM 5.3', 'GLM 5.3 Flash']);
});

test('model projection keeps catalog-provided labels without a Desktop model mirror', () => {
  const models = projectConversationModels({
    current: { provider: 'wrenyard', model: 'kimi-coding/k3' },
    routable: true,
    groups: [
      {
        id: 'wrenyard',
        name: 'Wrenyard',
        models: [
          { id: 'codebuddy/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
          { id: 'kimi-coding/k3', name: 'Kimi K3' },
        ],
      },
    ],
    failures: [],
  });

  assert.deepEqual(models.groups[0]?.models.map((model) => ({ id: model.model, label: model.label })), [
    { id: 'codebuddy/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { id: 'kimi-coding/k3', label: 'Kimi K3' },
  ]);
  assert.deepEqual(models.current, {
    provider: 'wrenyard',
    catalogProvider: 'kimi-coding',
    model: 'kimi-coding/k3',
    label: 'Kimi K3',
    providerLabel: 'Wrenyard',
    advertised: true,
    configured: true,
  });
});

test('model projection migrates the retired CodeBuddy iOA selection to its advertised logical id', () => {
  const models = projectConversationModels({
    current: { provider: 'wrenyard', model: 'codebuddy/hy4-preview-ioa' },
    routable: true,
    groups: [{
      id: 'wrenyard',
      name: 'Wrenyard',
      models: [{ id: 'codebuddy/hy4-preview', name: 'HY4 Preview' }],
    }],
    failures: [],
  });

  assert.deepEqual(models.current, {
    provider: 'wrenyard',
    catalogProvider: 'codebuddy',
    model: 'codebuddy/hy4-preview',
    label: 'HY4 Preview',
    providerLabel: 'Wrenyard',
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
    catalogProvider: 'legacy-provider',
    model: 'legacy-model',
    label: 'legacy-model',
    providerLabel: 'legacy-provider',
    advertised: false,
    configured: true,
  });
  assert.match(models.message ?? '', /Catalog: temporarily unavailable/);
});

test('model projection keeps only the configured Gateway provider', () => {
  const models = projectConversationModels(
    {
      current: { provider: 'legacy-provider', model: 'legacy-model' },
      routable: true,
      groups: [
        {
          id: 'wrenyard',
          name: 'Wrenyard',
          models: [{ id: 'codebuddy/deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
        },
        { id: 'legacy-provider', name: 'Legacy', models: [{ id: 'legacy-model', name: 'Legacy Model' }] },
      ],
      failures: [],
    },
    ['wrenyard'],
  );

  assert.deepEqual(
    models.groups.map((group) => group.provider),
    ['wrenyard'],
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

test('run_task card stays pending and without taskRun before the terminal result', () => {
  const items = projectConversationHistory([
    entry('tool/call', 1, { callId: 'call-run-1', name: 'run_task', arguments: '{"task_id":"task-abc"}' }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'tool');
  assert.equal(items[0].toolName, 'run_task');
  assert.equal(items[0].toolState, 'running');
  assert.equal(items[0].taskRun, undefined);
});

test('run_task result updates the same single card with raw text and parsed taskRun', () => {
  const payload = {
    task_run_id: 'run-001',
    task_id: 'task-abc',
    task_name: 'nightly-build',
    source: 'project',
    status: 'done',
    started_at: '2026-01-01T00:00:00Z',
    finished_at: '2026-01-01T00:05:00Z',
    resolved: {
      requested_agent_runtime: 'forge/fast',
      profile: 'profile-a',
      client: 'codebuddy',
      provider: 'zhipu-coding',
      model: 'glm-5.3',
      model_id: 'zhipu-coding/glm-5.3',
      mode: 'native',
      speed: {
        effective_tps: 12.5,
        source: 'local_31d',
        sample_count: 3,
        checked_at: '2026-01-01T00:00:00Z',
        expected_tps_met: true,
      },
      intelligence: 'high',
      reference_pricing: { source: 'catalog_reference', checked_at: '2026-01-01T00:00:00Z' },
    },
    usage: {
      attempt_count: 1,
      usage_event_count: 4,
      input_tokens: 1200,
      output_tokens: 800,
      total_tokens: 2000,
      agent_turn_ms: 300000,
      output_tps: 2.7,
      tps_contract: 'agent_turn_v1',
      completeness: 'complete',
      reference_cost_usd: 0.0123,
      reference_cost_complete: true,
      reference_cost_basis: 'catalog:glm-5.3',
    },
  };
  const items = projectConversationHistory([
    entry('tool/call', 1, { callId: 'call-run-1', name: 'run_task', arguments: '{"task_id":"task-abc"}' }),
    entry('tool/result', 2, {
      message: {
        source: { kind: 'tool', callId: 'call-run-1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-run-1',
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          isError: false,
        }],
      },
    }),
  ]);

  assert.equal(items.length, 1);
  const tool = items[0];
  assert.equal(tool.toolState, 'done');
  assert.equal(tool.toolResultText, JSON.stringify(payload));
  assert.ok(tool.taskRun);
  assert.equal(tool.taskRun?.taskRunId, 'run-001');
  assert.equal(tool.taskRun?.taskId, 'task-abc');
  assert.equal(tool.taskRun?.resolvedClient, 'codebuddy');
  assert.equal(tool.taskRun?.resolvedProvider, 'zhipu-coding');
  assert.equal(tool.taskRun?.resolvedModel, 'glm-5.3');
  assert.equal(tool.taskRun?.resolvedModelId, 'zhipu-coding/glm-5.3');
  assert.equal(tool.taskRun?.resolvedProfile, 'profile-a');
  assert.equal(tool.taskRun?.speed?.effectiveTps, 12.5);
  assert.equal(tool.taskRun?.usage.completeness, 'complete');
  assert.equal(tool.taskRun?.usage.inputTokens, 1200);
  assert.equal(tool.taskRun?.usage.referenceCostUsd, 0.0123);
  assert.equal(tool.taskRun?.usage.referenceCostComplete, true);
});

test('run_task result missing task_id is supplied only from the original call arguments', () => {
  const payload = {
    task_run_id: 'run-002',
    usage: { attempt_count: 1, usage_event_count: 2 },
  };
  const items = projectConversationHistory([
    entry('tool/call', 1, { callId: 'call-run-2', name: 'run_task', arguments: '{"task_id":"task-from-args"}' }),
    entry('tool/result', 2, {
      message: {
        source: { kind: 'tool', callId: 'call-run-2' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-run-2',
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          isError: false,
        }],
      },
    }),
  ]);

  assert.ok(items[0].taskRun);
  assert.equal(items[0].taskRun?.taskId, 'task-from-args');
  assert.equal(items[0].taskRun?.taskRunId, 'run-002');
});

test('malformed run_task result stays raw-only without a taskRun', () => {
  const items = projectConversationHistory([
    entry('tool/call', 1, { callId: 'call-run-3', name: 'run_task', arguments: '{"task_id":"task-x"}' }),
    entry('tool/result', 2, {
      message: {
        source: { kind: 'tool', callId: 'call-run-3' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-run-3',
          content: [{ type: 'text', text: 'not json at all' }],
          isError: false,
        }],
      },
    }),
  ]);

  assert.equal(items[0].toolResultText, 'not json at all');
  assert.equal(items[0].taskRun, undefined);
});

test('incomplete run_task result without usage stays raw-only', () => {
  const payload = { task_run_id: 'run-004', task_id: 'task-y' };
  const items = projectConversationHistory([
    entry('tool/call', 1, { callId: 'call-run-4', name: 'run_task', arguments: '{"task_id":"task-y"}' }),
    entry('tool/result', 2, {
      message: {
        source: { kind: 'tool', callId: 'call-run-4' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-run-4',
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          isError: false,
        }],
      },
    }),
  ]);

  assert.ok(items[0].toolResultText);
  assert.equal(items[0].taskRun, undefined);
});

test('unrelated tool result may expose raw text but never a taskRun', () => {
  const items = projectConversationHistory([
    entry('tool/call', 1, { callId: 'call-read', name: 'Read', arguments: '{"path":"README.md"}' }),
    entry('tool/result', 2, {
      message: {
        source: { kind: 'tool', callId: 'call-read' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-read',
          content: [{ type: 'text', text: '# README contents' }],
          isError: false,
        }],
      },
    }),
  ]);

  assert.equal(items[0].toolName, 'Read');
  assert.equal(items[0].toolResultText, '# README contents');
  assert.equal(items[0].taskRun, undefined);
});

test('raw run_task result text is capped at 16000 characters', () => {
  const big = 'x'.repeat(20_000);
  const items = projectConversationHistory([
    entry('tool/call', 1, { callId: 'call-read-big', name: 'Read', arguments: '{}' }),
    entry('tool/result', 2, {
      message: {
        source: { kind: 'tool', callId: 'call-read-big' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-read-big',
          content: [{ type: 'text', text: big }],
          isError: false,
        }],
      },
    }),
  ]);

  assert.equal(items[0].toolResultText?.length, 16_000);
  assert.equal(items[0].toolResultText, big.slice(0, 16_000));
  assert.equal(items[0].taskRun, undefined);
});
