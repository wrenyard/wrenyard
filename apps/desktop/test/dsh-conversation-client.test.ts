import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DshConversationClient,
  persistedModelSelectionRepair,
  projectConversationHistory,
  projectConversationModels,
  projectHostModels,
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

test('tool call that precedes the first assistant event still joins its data.turn group', () => {
  const items = projectConversationHistory([
    entry('tool/call', 1, { turn: 9, callId: 'call-9', name: 'Read', arguments: '{"path":"README.md"}' }),
    entry('tool/result', 2, {
      message: {
        source: { kind: 'tool', callId: 'call-9' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-9',
          content: [],
          isError: false,
        }],
      },
    }),
    entry('assistant/message', 3, {
      turn: 9,
      step: 1,
      message: { content: [{ type: 'text', text: '结果如下。' }] },
    }),
  ]);

  assert.deepEqual(items.map((item) => ({ kind: item.kind, turnId: item.turnId })), [
    { kind: 'tool', turnId: 'turn-9' },
    { kind: 'assistant', turnId: 'turn-9' },
  ]);
});

test('assistant item id for one turn and step is stable from the streaming draft to the finalized message', () => {
  const streamed = projectConversationHistory([
    entry('assistant/chunk', 1, { turn: 5, step: 1, chunk: { type: 'reasoning-delta', text: '先查' } }),
    entry('assistant/chunk', 2, { turn: 5, step: 1, chunk: { type: 'text-delta', text: '检查中' } }),
  ]);
  const finalized = projectConversationHistory([
    entry('assistant/chunk', 1, { turn: 5, step: 1, chunk: { type: 'reasoning-delta', text: '先查' } }),
    entry('assistant/chunk', 2, { turn: 5, step: 1, chunk: { type: 'text-delta', text: '检查中' } }),
    entry('assistant/message', 3, {
      turn: 5,
      step: 1,
      message: { content: [{ type: 'reasoning', text: '先查' }, { type: 'text', text: '检查完成' }] },
    }),
  ]);

  const streamedAssistant = streamed.find((item) => item.kind === 'assistant');
  const finalizedAssistant = finalized.find((item) => item.kind === 'assistant');
  assert.ok(streamedAssistant);
  assert.ok(finalizedAssistant);
  // Draft reasoning/text expansion is keyed by the item id, so the id must not
  // change once the message is finalized.
  assert.ok(streamedAssistant.id);
  assert.equal(finalizedAssistant.id, streamedAssistant.id);
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

test('persisted model repair rewrites only the retired HY4 public alias to the advertised logical id', () => {
  const groups = projectConversationModels({
    current: { provider: 'wrenyard', model: 'codebuddy/hy4-preview-ioa' },
    routable: true,
    groups: [{
      id: 'wrenyard',
      name: 'Wrenyard',
      models: [{
        id: 'codebuddy/hy4-preview',
        name: 'HY4 Preview',
        reasoning: { defaultEffort: 'medium' },
      }],
    }],
    failures: [],
  }).groups;

  assert.deepEqual(
    persistedModelSelectionRepair(
      { provider: 'wrenyard', model: 'codebuddy/hy4-preview-ioa' },
      groups,
    ),
    { provider: 'wrenyard', model: 'codebuddy/hy4-preview', reasoningEffort: 'medium' },
  );
  assert.equal(
    persistedModelSelectionRepair(
      { provider: 'wrenyard', model: 'codebuddy/hy4-preview' },
      groups,
    ),
    undefined,
    'the current logical id must not cause a persistence mutation',
  );
  assert.equal(
    persistedModelSelectionRepair(
      { provider: 'wrenyard', model: 'codebuddy/genuinely-unknown' },
      groups,
    ),
    undefined,
    'an unknown id must stay visible for diagnosis rather than silently switching models',
  );
});

test('resumed legacy HY4 selection is persisted before the next prompt without replacing session history', async () => {
  const client = new DshConversationClient({
    baseUrl: 'http://127.0.0.1:1',
    workspaceId: 'workspace-1',
    workspace: {
      status: 'configured',
      path: '/workspace',
      configPath: '/config.json',
      source: 'user-config',
      readOnly: false,
    },
    configuredProviderIds: ['wrenyard'],
    onChanged() {},
  });
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const harness = client as unknown as {
    selectedSessionId: string;
    history: { events: ReturnType<typeof entry>[]; hasMore: boolean };
    refreshModels(sessionId: string): Promise<void>;
    rpc(method: string, payload: Record<string, unknown>): Promise<unknown>;
  };
  harness.selectedSessionId = 'session-old';
  harness.history = {
    events: [entry('user/message', 1, {
      source: { kind: 'user' },
      content: [{ type: 'text', text: '保留的旧会话内容' }],
    })],
    hasMore: false,
  };
  harness.rpc = async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'session.models') {
      return {
        current: { provider: 'wrenyard', model: 'codebuddy/hy4-preview-ioa' },
        routable: true,
        groups: [{
          id: 'wrenyard',
          name: 'Wrenyard',
          models: [{ id: 'codebuddy/hy4-preview', name: 'HY4 Preview' }],
        }],
        failures: [],
      };
    }
    if (method === 'session.selectModel') {
      return { selected: { provider: 'wrenyard', model: 'codebuddy/hy4-preview' } };
    }
    if (method === 'session.prompt') return {};
    throw new Error(`unexpected ${method}`);
  };

  await harness.refreshModels('session-old');
  await client.send('继续');

  assert.deepEqual(calls.slice(0, 3), [
    { method: 'session.models', payload: { sessionId: 'session-old' } },
    {
      method: 'session.selectModel',
      payload: {
        sessionId: 'session-old',
        provider: 'wrenyard',
        model: 'codebuddy/hy4-preview',
      },
    },
    {
      method: 'session.prompt',
      payload: {
        sessionId: 'session-old',
        mode: 'queue',
        content: [{ type: 'text', text: '继续' }],
      },
    },
  ]);
  assert.equal(client.snapshot().models.current?.model, 'codebuddy/hy4-preview');
  assert.equal(client.snapshot().items[0]?.text, '保留的旧会话内容');
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

test('host model projection accepts the DSH 0.1.1-rc.2 llm.models shape without inventing a current', () => {
  const models = projectHostModels(hostModelDirectory(), ['wrenyard']);
  assert.equal(models.status, 'ready');
  assert.equal(models.current, undefined, 'the host catalog must never fabricate a current selection');
  assert.equal(models.routable, true, 'routable derives from an advertised, configured model');
  assert.equal(models.groups.length, 1);
  assert.equal(models.groups[0]?.models.length, 2);
});

test('host model projection marks routable false when no advertised configured model exists', () => {
  const models = projectHostModels({
    groups: [{
      id: 'legacy-provider',
      name: 'Legacy',
      models: [{ id: 'legacy-model', name: 'Legacy Model' }],
    }],
    failures: [],
  }, ['wrenyard']);
  assert.equal(models.current, undefined);
  assert.equal(models.routable, false);
});

test('per-session model projection must not accept the host-only groups/failures payload', () => {
  assert.throws(
    () => projectConversationModels(hostModelDirectory()),
    /DSH 模型目录格式无效/,
    'llm.models must never be parsed as session.models',
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

function conversationClientHarness() {
  const client = new DshConversationClient({
    baseUrl: 'http://127.0.0.1:1',
    workspaceId: 'workspace-1',
    workspace: {
      status: 'configured',
      path: '/workspace',
      configPath: '/config.json',
      source: 'user-config',
      readOnly: false,
    },
    configuredProviderIds: ['wrenyard'],
    onChanged() {},
  });
  return {
    client,
    state: client as unknown as {
      sessions: Map<string, { sessionId: string; updatedAt: number; running: boolean; blank: boolean }>;
      workspaceSessionIds: Set<string>;
      selectedSessionId?: string;
      history: { events: ReturnType<typeof entry>[]; hasMore: boolean };
      models: ReturnType<typeof projectConversationModels>;
      rpc(method: string, payload: Record<string, unknown>): Promise<unknown>;
    },
  };
}

function modelDirectory(current = 'codebuddy/deepseek-v4-flash') {
  return {
    current: { provider: 'wrenyard', model: current },
    routable: true,
    groups: [{
      id: 'wrenyard',
      name: 'Wrenyard',
      models: [
        { id: 'codebuddy/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'codebuddy/hy4-preview', name: 'HY4 Preview', reasoning: { defaultEffort: 'medium' } },
      ],
    }],
    failures: [],
  };
}

// The exact host response shape for llm.models in DSH 0.1.1-rc.2: only groups
// and failures, no current selection and no routable flag.
function hostModelDirectory() {
  return {
    groups: [{
      id: 'wrenyard',
      name: 'Wrenyard',
      models: [
        { id: 'codebuddy/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'codebuddy/hy4-preview', name: 'HY4 Preview', reasoning: { defaultEffort: 'medium' } },
      ],
    }],
    failures: [],
  };
}

test('New is a local reset and repeated New or empty send creates no durable session', async () => {
  const { client, state } = conversationClientHarness();
  state.sessions.set('old', { sessionId: 'old', updatedAt: 1, running: false, blank: false });
  state.workspaceSessionIds.add('old');
  state.selectedSessionId = 'old';
  state.history = { events: [entry('user/message', 1, { content: [{ type: 'text', text: '旧历史' }] })], hasMore: false };
  const calls: string[] = [];
  state.rpc = async (method) => {
    calls.push(method);
    throw new Error(`unexpected ${method}`);
  };

  await client.create();
  await client.create();
  await assert.rejects(client.send('   '), /消息不能为空/);

  assert.deepEqual(calls, []);
  assert.equal(client.snapshot().selectedSessionId, undefined);
  assert.deepEqual(client.snapshot().items, []);
  assert.deepEqual(client.snapshot().sessions.map((session) => session.id), ['old']);
});

test('concurrent first sends share one session create and one prompt', async () => {
  const { client, state } = conversationClientHarness();
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  state.rpc = async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'session.create') return { sessionId: 'new-1' };
    if (method === 'session.models') return modelDirectory();
    if (method === 'session.prompt') return {};
    if (method === 'session.history') return { events: [], hasMore: false };
    throw new Error(`unexpected ${method}`);
  };

  const [first, second] = await Promise.all([client.send('第一条'), client.send('第一条')]);

  assert.equal(calls.filter((call) => call.method === 'session.create').length, 1);
  assert.equal(calls.filter((call) => call.method === 'session.prompt').length, 1);
  assert.equal(first.selectedSessionId, 'new-1');
  assert.equal(second.selectedSessionId, 'new-1');
});

test('failed first prompt retries on the same blank session without another create', async () => {
  const { client, state } = conversationClientHarness();
  let promptAttempts = 0;
  const calls: string[] = [];
  state.rpc = async (method) => {
    calls.push(method);
    if (method === 'session.create') return { sessionId: 'new-retry' };
    if (method === 'session.models') return modelDirectory();
    if (method === 'session.prompt') {
      promptAttempts += 1;
      if (promptAttempts === 1) throw new Error('temporary prompt failure');
      return {};
    }
    if (method === 'session.history') return { events: [], hasMore: false };
    throw new Error(`unexpected ${method}`);
  };

  await assert.rejects(client.send('重试内容'), /temporary prompt failure/);
  await client.send('重试内容');

  assert.equal(calls.filter((method) => method === 'session.create').length, 1);
  assert.equal(calls.filter((method) => method === 'session.prompt').length, 2);
  assert.equal(calls.some((method) => method === 'session.cancel' || method === 'session.delete'), false);
});

test('switching to an existing session during first materialization does not steal selection or duplicate prompt', async () => {
  const { client, state } = conversationClientHarness();
  state.sessions.set('old', { sessionId: 'old', updatedAt: 1, running: false, blank: false });
  state.workspaceSessionIds.add('old');
  state.selectedSessionId = 'old';
  await client.create();

  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  state.rpc = async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'session.create') {
      await createGate;
      return { sessionId: 'new-race' };
    }
    if (method === 'session.models') return modelDirectory();
    if (method === 'session.history') return { events: [], hasMore: false };
    if (method === 'session.prompt') return {};
    throw new Error(`unexpected ${method}`);
  };

  const sending = client.send('新会话消息');
  await Promise.resolve();
  const selecting = client.select('old');
  releaseCreate();
  await Promise.all([sending, selecting]);

  assert.equal(client.snapshot().selectedSessionId, 'old');
  const prompts = calls.filter((call) => call.method === 'session.prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].payload.sessionId, 'new-race');
  assert.equal(calls.filter((call) => call.method === 'session.create').length, 1);
});

test('first send reapplies the prior advertised logical model before prompting', async () => {
  const { client, state } = conversationClientHarness();
  state.sessions.set('old', { sessionId: 'old', updatedAt: 1, running: false, blank: false });
  state.workspaceSessionIds.add('old');
  state.selectedSessionId = 'old';
  state.models = projectConversationModels(modelDirectory('codebuddy/hy4-preview'), ['wrenyard']);
  await client.create();

  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  state.rpc = async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'session.create') return { sessionId: 'new-model' };
    if (method === 'session.models') return modelDirectory();
    if (method === 'session.selectModel') {
      return { selected: { provider: 'wrenyard', model: 'codebuddy/hy4-preview', reasoningEffort: 'medium' } };
    }
    if (method === 'session.prompt') return {};
    if (method === 'session.history') return { events: [], hasMore: false };
    throw new Error(`unexpected ${method}`);
  };

  await client.send('沿用模型');

  assert.deepEqual(calls.map((call) => call.method).slice(0, 4), [
    'session.create',
    'session.models',
    'session.selectModel',
    'session.prompt',
  ]);
  assert.equal(calls[2].payload.model, 'codebuddy/hy4-preview');
  assert.equal(calls[3].payload.sessionId, 'new-model');
});

test('empty workspace start loads the catalog via llm.models without creating a session', async () => {
  const { client, state } = conversationClientHarness();
  const calls: string[] = [];
  state.rpc = async (method) => {
    calls.push(method);
    if (method === 'session.list') return { items: [] };
    if (method === 'workspace.list') return { items: [{ workspaceId: 'workspace-1', sessionIds: [] }] };
    if (method === 'llm.models') return hostModelDirectory();
    throw new Error(`unexpected ${method}`);
  };

  await client.start();

  assert.ok(calls.includes('llm.models'), 'empty workspace must fetch the host catalog via llm.models');
  assert.equal(calls.some((method) => method === 'session.create'), false, 'no durable session is created on empty start');
  const snapshot = client.snapshot();
  assert.equal(snapshot.selectedSessionId, undefined);
  assert.equal(snapshot.models.status, 'ready');
  assert.ok(snapshot.models.groups.length > 0, 'the draft model directory is populated');
  assert.equal(snapshot.models.current, undefined, 'the draft catalog must not invent a current selection');
  assert.equal(snapshot.models.routable, true, 'routable is derived from an advertised configured model');
});

test('draft model selection updates only the in-memory selection without persistence', async () => {
  const { client, state } = conversationClientHarness();
  state.rpc = async (method) => {
    if (method === 'session.list') return { items: [] };
    if (method === 'workspace.list') return { items: [{ workspaceId: 'workspace-1', sessionIds: [] }] };
    if (method === 'llm.models') return hostModelDirectory();
    throw new Error(`unexpected ${method}`);
  };
  await client.start();

  const calls: string[] = [];
  state.rpc = async (method) => {
    calls.push(method);
    throw new Error(`unexpected ${method}`);
  };

  const snapshot = await client.selectModel('wrenyard', 'codebuddy/hy4-preview');

  assert.deepEqual(calls, [], 'draft selection must not issue any persistence RPC');
  assert.equal(snapshot.selectedSessionId, undefined);
  assert.equal(snapshot.models.current?.model, 'codebuddy/hy4-preview', 'the draft current selection is reflected');
});

test('first send materializes exactly one session with the draft selection then prompts', async () => {
  const { client, state } = conversationClientHarness();
  state.rpc = async (method) => {
    if (method === 'session.list') return { items: [] };
    if (method === 'workspace.list') return { items: [{ workspaceId: 'workspace-1', sessionIds: [] }] };
    if (method === 'llm.models') return hostModelDirectory();
    throw new Error(`unexpected ${method}`);
  };
  await client.start();
  await client.selectModel('wrenyard', 'codebuddy/hy4-preview');

  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  state.rpc = async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'session.create') return { sessionId: 'new-draft' };
    if (method === 'session.models') return modelDirectory();
    if (method === 'session.selectModel') return { selected: { provider: 'wrenyard', model: 'codebuddy/hy4-preview', reasoningEffort: 'medium' } };
    if (method === 'session.prompt') return {};
    if (method === 'session.history') return { events: [], hasMore: false };
    throw new Error(`unexpected ${method}`);
  };

  await client.send('首条消息');

  assert.equal(calls.filter((call) => call.method === 'session.create').length, 1, 'exactly one session is created');
  assert.deepEqual(
    calls.map((call) => call.method).slice(0, 4),
    ['session.create', 'session.models', 'session.selectModel', 'session.prompt'],
  );
  assert.equal(calls[2].payload.model, 'codebuddy/hy4-preview', 'the exact draft choice is applied before prompting');
  const snapshot = client.snapshot();
  assert.equal(snapshot.selectedSessionId, 'new-draft');
  assert.equal(snapshot.models.current?.model, 'codebuddy/hy4-preview');
});

test('host-created blank session stays hidden until first send reuses it', async () => {
  const { client, state } = conversationClientHarness();
  state.rpc = async (method) => {
    if (method === 'session.list') {
      return { items: [{ sessionId: 'blank-1', updatedAt: 1, running: false, blank: true }] };
    }
    if (method === 'workspace.list') {
      return { items: [{ workspaceId: 'workspace-1', sessionIds: ['blank-1'] }] };
    }
    if (method === 'llm.models') return hostModelDirectory();
    throw new Error(`unexpected ${method}`);
  };

  await client.start();
  assert.equal(client.snapshot().selectedSessionId, undefined);
  assert.deepEqual(client.snapshot().sessions, [], 'blank host state must not appear as a conversation');

  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  state.rpc = async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'session.models') return modelDirectory();
    if (method === 'session.prompt') return {};
    if (method === 'session.history') return { events: [], hasMore: false };
    throw new Error(`unexpected ${method}`);
  };

  await client.send('开始');
  assert.equal(calls.some((call) => call.method === 'session.create'), false);
  assert.equal(calls.find((call) => call.method === 'session.prompt')?.payload.sessionId, 'blank-1');
  assert.equal(client.snapshot().selectedSessionId, 'blank-1');
});

test('repeated New and empty send remain non-persistent before the first message', async () => {
  const { client, state } = conversationClientHarness();
  state.rpc = async (method) => {
    if (method === 'session.list') return { items: [] };
    if (method === 'workspace.list') return { items: [{ workspaceId: 'workspace-1', sessionIds: [] }] };
    if (method === 'llm.models') return hostModelDirectory();
    throw new Error(`unexpected ${method}`);
  };
  await client.start();

  await client.create();
  await client.create();
  await assert.rejects(client.send('   '), /消息不能为空/);

  const calls: string[] = [];
  state.rpc = async (method) => {
    calls.push(method);
    throw new Error(`unexpected ${method}`);
  };

  const snapshot = client.snapshot();
  assert.deepEqual(calls, [], 'New and empty send create no durable session or persistence RPC');
  assert.equal(snapshot.selectedSessionId, undefined);
  assert.equal(snapshot.models.status, 'ready', 'the catalog is retained through New');
});
