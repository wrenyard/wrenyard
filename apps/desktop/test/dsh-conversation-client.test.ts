import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DshConversationClient,
  persistedModelSelectionRepair,
  projectConversation,
  projectConversationHistory,
  projectConversationModels,
  projectConversationTurns,
  projectHostModels,
} from '../src/dsh-conversation-client.js';

function entry(type: string, seq: number, data: Record<string, unknown>) {
  return { event: { type, seq, time: 1_700_000_000_000 + seq, data } };
}

function toolResult(callId: string, text: string, isError = false) {
  return entry('tool/result', 0, {
    message: {
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }],
    },
  });
}

/** Re-seq a helper-built event so a composed history keeps a monotonic seq. */
function at(seq: number, built: ReturnType<typeof entry>) {
  return { event: { ...built.event, seq, time: 1_700_000_000_000 + seq } };
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

  assert.deepEqual(items.map((item) => ({ kind: item.kind, text: item.text })), [
    { kind: 'user', text: '请检查 workspace' },
    { kind: 'assistant', text: '检查完成' },
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
  // The draft/finalized assistant item id is the streaming identity, so the id
  // must not change once the message is finalized.
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
          { id: 'codebuddy/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
          { id: 'kimi-coding/k3', name: 'Kimi K3' },
        ],
      },
    ],
    failures: [],
  });

  assert.deepEqual(models.groups[0]?.models.map((model) => ({ id: model.model, label: model.label })), [
    { id: 'codebuddy/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
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

test('model projection derives input types from exact Catalog capabilities and leaves unknown models unresolved', () => {
  const models = projectConversationModels({
    current: { provider: 'wrenyard', model: 'codebuddy/deepseek-v4.1-flash' },
    routable: true,
    groups: [{
      id: 'wrenyard',
      name: 'Wrenyard',
      models: [
        { id: 'codebuddy/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
        { id: 'kimi-coding/k3', name: 'Kimi K3' },
        { id: 'zhipu-coding/glm-5.3', name: 'GLM-5.3' },
        { id: 'openrouter/nex-agi/nex-n2.5-mini:free', name: 'Nex N2.5 Mini Free' },
        { id: 'codebuddy/does-not-exist', name: 'Unknown Model' },
      ],
    }],
    failures: [],
  });

  const byModel = new Map((models.groups[0]?.models ?? []).map((model) => [model.model, model]));
  // Image + text models keep both capabilities.
  assert.deepEqual(byModel.get('codebuddy/deepseek-v4.1-flash')?.inputTypes, ['text', 'image']);
  assert.deepEqual(byModel.get('kimi-coding/k3')?.inputTypes, ['text', 'image']);
  // Gateway provider prefix maps to the exact catalog provider/model (namespaced
  // OpenRouter ids keep the slash inside the model segment).
  assert.deepEqual(byModel.get('openrouter/nex-agi/nex-n2.5-mini:free')?.inputTypes, ['text', 'image']);
  // Text-only models keep exactly text.
  assert.deepEqual(byModel.get('zhipu-coding/glm-5.3')?.inputTypes, ['text']);
  // An unmatched model stays unknown; the field is omitted rather than assumed.
  assert.equal(byModel.get('codebuddy/does-not-exist')?.inputTypes, undefined);
  // Current selection projection does not carry inputTypes; it is an option field.
  assert.equal(models.current?.configured, true);
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
          models: [{ id: 'codebuddy/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }],
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
      generation_ms: 300000,
      output_tps: 2.7,
      tps_contract: 'response_v1',
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

function modelDirectory(current = 'codebuddy/deepseek-v4.1-flash') {
  return {
    current: { provider: 'wrenyard', model: current },
    routable: true,
    groups: [{
      id: 'wrenyard',
      name: 'Wrenyard',
      models: [
        { id: 'codebuddy/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
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
        { id: 'codebuddy/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function liveClient(client: DshConversationClient) {
  return client as unknown as {
    refreshIndex(): Promise<void>;
    loadHistory(id: string): Promise<void>;
    handleMux(frame: Record<string, unknown>): void;
  };
}

function userEntry(seq: number, text: string) {
  return entry('user/message', seq, { source: { kind: 'user' }, content: [{ type: 'text', text }] });
}

test('first send survives an older index response triggered during creation', async () => {
  const { client, state } = conversationClientHarness();
  const live = liveClient(client);
  const indexGate = deferred<void>();
  const modelGate = deferred<void>();
  let refreshing: Promise<void> | undefined;
  state.rpc = async (method) => {
    if (method === 'session.create') {
      refreshing = live.refreshIndex();
      return { sessionId: 'fresh' };
    }
    if (method === 'session.list') { await indexGate.promise; return { items: [] }; }
    if (method === 'workspace.list') {
      await indexGate.promise;
      return { items: [{ workspaceId: 'workspace-1', sessionIds: [] }] };
    }
    if (method === 'session.models') { await modelGate.promise; return modelDirectory(); }
    if (method === 'session.prompt') return {};
    if (method === 'session.history') return { events: [], hasMore: false };
    throw new Error(`unexpected ${method}`);
  };
  const sending = client.send('first');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(refreshing, 'exercise the real index refresh');
  indexGate.resolve();
  await refreshing;
  modelGate.resolve();
  await sending;
  assert.ok(state.workspaceSessionIds.has('fresh'));
  live.handleMux({ type: 'session/event', sessionId: 'fresh', ...userEntry(1, 'first') });
  assert.equal(client.snapshot().items[0]?.text, 'first');
  client.stop();
});

test('a late history page merges live frames in sequence without duplicates', async () => {
  const { client, state } = conversationClientHarness();
  const live = liveClient(client);
  state.selectedSessionId = 'a';
  state.workspaceSessionIds.add('a');
  const page = deferred<unknown>();
  state.rpc = async () => page.promise;
  const loading = live.loadHistory('a');
  live.handleMux({ type: 'session/event', sessionId: 'a', ...userEntry(1, 'live first') });
  live.handleMux({ type: 'session/event', sessionId: 'a', ...userEntry(3, 'live third') });
  page.resolve({ events: [userEntry(1, 'saved first'), userEntry(2, 'saved second')], hasMore: true });
  await loading;
  assert.deepEqual(client.snapshot().items.map((item) => item.text), ['saved first', 'saved second', 'live third']);
  assert.equal(client.snapshot().hasMore, true);
  client.stop();
});

test('an obsolete history response cannot replace a reselected session', async () => {
  const { client, state } = conversationClientHarness();
  for (const id of ['a', 'b']) {
    state.sessions.set(id, { sessionId: id, updatedAt: 1, running: false, blank: false });
    state.workspaceSessionIds.add(id);
  }
  const stale = deferred<unknown>();
  let historyCalls = 0;
  state.rpc = async (method) => {
    if (method === 'session.models') return modelDirectory();
    if (method === 'session.history') {
      if (++historyCalls === 1) return stale.promise;
      return { events: [userEntry(1, 'current')], hasMore: false };
    }
    throw new Error(`unexpected ${method}`);
  };
  const first = client.select('a');
  await client.select('b');
  await client.select('a');
  stale.resolve({ events: [userEntry(1, 'obsolete')], hasMore: false });
  await first;
  assert.deepEqual(client.snapshot().items.map((item) => item.text), ['current']);
  client.stop();
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

test('turn projection reports exact boundaries, deduplicated usage, and paired throughput', () => {
  const entries = [
    entry('turn/start', 1, { turn: 1 }),
    entry('assistant/chunk', 2, { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: '思考中' } }),
    entry('assistant/chunk', 3, { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1966, outputTokens: 47 } } }),
    // DSH repeats the same per-step observation; it must count exactly once.
    entry('assistant/chunk', 4, { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1966, outputTokens: 47 } } }),
    entry('assistant/chunk', 5, { turn: 1, step: 1, chunk: { type: 'text-delta', text: '完成' } }),
    entry('assistant/chunk', 6, { turn: 1, step: 1, chunk: { type: 'finish' } }),
    entry('assistant/message', 7, {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'reasoning', text: '思考中' }, { type: 'text', text: '完成' }] },
    }),
    entry('turn/end', 8, { turn: 1, reason: { kind: 'completed' } }),
  ];

  const items = projectConversationHistory(entries);
  const turns = projectConversationTurns(entries);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].id, 'turn-1');
  // Exact turn/start and turn/end event times, not arrival or mutation times.
  assert.equal(turns[0].startedAt, 1_700_000_000_001);
  assert.equal(turns[0].endedAt, 1_700_000_000_008);
  assert.equal(turns[0].running, false);
  assert.equal(turns[0].inputTokens, 1966, 'a repeated per-step usage observation is counted once');
  assert.equal(turns[0].outputTokens, 47);
  // Generation is measured from the first nonempty delta of the response to its
  // own finish chunk — never to the turn end, and never across a tool wait.
  assert.equal(turns[0].outputTps, 47 / ((1_700_000_000_006 - 1_700_000_000_002) / 1_000));
  assert.equal(turns[0].finalItemId, items.at(-1)?.id, 'the final assistant body of the completed turn');
  assert.equal(items.at(-1)?.kind, 'assistant');
  assert.equal(items.at(-1)?.text, '完成', 'reasoning is never projected as content');
});

test('turn timing sums per-step responses and never counts a huge tool wait as generation', () => {
  const entries = [
    entry('turn/start', 1, { turn: 1 }),
    // Step 1: 2s of generation, then a 100s tool wait that must not be measured.
    entry('assistant/chunk', 2, { turn: 1, step: 1, chunk: { type: 'text-delta', text: '先查' } }),
    entry('assistant/chunk', 3, { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } } }),
    entry('assistant/chunk', 4, { turn: 1, step: 1, chunk: { type: 'finish' } }),
    entry('tool/call', 5, { turn: 1, step: 1, callId: 'c-slow', name: 'run_task', arguments: '{"task_id":"slow-task"}' }),
    entry('tool/result', 6, {
      message: {
        source: { kind: 'tool', callId: 'c-slow' },
        content: [{ type: 'tool-result', toolCallId: 'c-slow', content: [{ type: 'text', text: '{"task_run_id":"r-1"}' }], isError: false }],
      },
    }),
    // Step 2: a duplicated usage observation must still count once per step.
    entry('assistant/chunk', 7, { turn: 1, step: 2, chunk: { type: 'text-delta', text: '再写' } }),
    entry('assistant/chunk', 8, { turn: 1, step: 2, chunk: { type: 'usage', usage: { inputTokens: 300, outputTokens: 30 } } }),
    entry('assistant/chunk', 9, { turn: 1, step: 2, chunk: { type: 'usage', usage: { inputTokens: 300, outputTokens: 30 } } }),
    entry('assistant/chunk', 10, { turn: 1, step: 2, chunk: { type: 'finish' } }),
    entry('turn/end', 11, { turn: 1, reason: { kind: 'completed' } }),
  ];

  const elapsed = [0, 0, 1000, 2000, 2001, 102001, 103000, 104000, 104000, 105000, 205000];
  entries.forEach((item, index) => { item.event.time = 1_700_000_000_000 + elapsed[index]; });
  const turns = projectConversationTurns(entries);

  assert.equal(turns.length, 1);
  // Usage is summed once per step across the two responses.
  assert.equal(turns[0].inputTokens, 400);
  assert.equal(turns[0].outputTokens, 50);
  // 4s of measured generation across two responses; the 100s turn tail after the
  // last finish is excluded, so the rate never collapses toward zero.
  assert.equal(turns[0].outputTps, 50 / 4);
  assert.equal(turns[0].endedAt, 1_700_000_205_000);
  assert.equal(turns[0].running, false);
});

test('a response finish never ends its turn and never marks a running turn complete', () => {
  const entries = [
    entry('turn/start', 1, { turn: 1 }),
    entry('assistant/chunk', 2, { turn: 1, step: 1, chunk: { type: 'text-delta', text: '完成' } }),
    entry('assistant/chunk', 3, { turn: 1, step: 1, chunk: { type: 'finish' } }),
  ];

  const turns = projectConversationTurns(entries);

  assert.equal(turns[0].running, true, 'only turn/end ends a turn');
  assert.equal(turns[0].endedAt, undefined);
  assert.equal(turns[0].finalItemId, undefined, 'a finish never supplies a final item');
});

test('an empty delta does not start the generation clock', () => {
  const entries = [
    entry('turn/start', 1, { turn: 1 }),
    entry('assistant/chunk', 2, { turn: 1, step: 1, chunk: { type: 'text-delta', text: '' } }),
    entry('assistant/chunk', 3, { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: '' } }),
    entry('assistant/chunk', 4, { turn: 1, step: 1, chunk: { type: 'tool-call-delta', arguments: '' } }),
    // The first delta that genuinely carries content owns the clock.
    entry('assistant/chunk', 5, { turn: 1, step: 1, chunk: { type: 'text-delta', text: '有内容' } }),
    entry('assistant/chunk', 6, { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } } }),
    entry('assistant/chunk', 7, { turn: 1, step: 1, chunk: { type: 'finish' } }),
    entry('turn/end', 8, { turn: 1, reason: { kind: 'completed' } }),
  ];

  const turns = projectConversationTurns(entries);

  assert.equal(turns[0].outputTokens, 4);
  assert.equal(turns[0].outputTps, 4 / ((1_700_000_000_007 - 1_700_000_000_005) / 1_000));
});

test('out-of-order and replayed events fold by seq, with duplicates counted once', () => {
  const turnStart = entry('turn/start', 1, { turn: 1 });
  const reasoning = entry('assistant/chunk', 2, { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: '思考' } });
  const usage = entry('assistant/chunk', 3, { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 50, outputTokens: 9 } } });
  const text = entry('assistant/chunk', 4, { turn: 1, step: 1, chunk: { type: 'text-delta', text: '回答' } });
  const finish = entry('assistant/chunk', 5, { turn: 1, step: 1, chunk: { type: 'finish' } });
  const message = entry('assistant/message', 6, {
    turn: 1,
    step: 1,
    message: { content: [{ type: 'text', text: '回答' }] },
  });
  const turnEnd = entry('turn/end', 7, { turn: 1, reason: { kind: 'completed' } });

  // A recovered page merged ahead of live frames, plus an exact duplicate of the
  // opening frame: seq order must win and the duplicate must be folded once.
  const turns = projectConversationTurns([turnEnd, usage, turnStart, reasoning, usage, text, finish, message]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].startedAt, 1_700_000_000_001);
  assert.equal(turns[0].endedAt, 1_700_000_000_007);
  assert.equal(turns[0].inputTokens, 50, 'a replayed usage frame is not double counted');
  assert.equal(turns[0].outputTokens, 9);
  assert.equal(turns[0].outputTps, 9 / 0.003, '3ms from the first delta (seq 2) to finish (seq 5)');
  assert.equal(turns[0].dispatchCount, 0);
  assert.equal(turns[0].finalItemId, 'assistant-turn-1:1');
});

test('a task result reporting a failed status marks the card failed even without isError', () => {
  const payload = {
    task_run_id: 'run-failed',
    task_id: 'task-x',
    status: 'failed',
    started_at: '2026-01-01T00:00:00Z',
    finished_at: '2026-01-01T00:01:00Z',
    usage: { attempt_count: 1, usage_event_count: 2, output_tokens: 10 },
  };
  const items = projectConversationHistory([
    entry('tool/call', 1, { callId: 'call-failed', name: 'run_task', arguments: '{"task_id":"task-x"}' }),
    entry('tool/result', 2, {
      message: {
        source: { kind: 'tool', callId: 'call-failed' },
        content: [{ type: 'tool-result', toolCallId: 'call-failed', content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false }],
      },
    }),
  ]);

  assert.equal(items[0].toolState, 'failed');
  assert.equal(items[0].taskRun?.status, 'failed');
});

test('a cancelled task result marks the card failed too', () => {
  const payload = {
    task_run_id: 'run-cancelled',
    task_id: 'task-y',
    status: 'cancelled',
    usage: { attempt_count: 1, usage_event_count: 1 },
  };
  const items = projectConversationHistory([
    entry('tool/call', 1, { callId: 'call-cancelled', name: 'run_task', arguments: '{"task_id":"task-y"}' }),
    entry('tool/result', 2, {
      message: {
        source: { kind: 'tool', callId: 'call-cancelled' },
        content: [{ type: 'tool-result', toolCallId: 'call-cancelled', content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false }],
      },
    }),
  ]);

  assert.equal(items[0].toolState, 'failed');
});

test('a task result reporting a done status stays successful', () => {
  const payload = {
    task_run_id: 'run-done',
    task_id: 'task-z',
    status: 'done',
    usage: { attempt_count: 1, usage_event_count: 3, output_tokens: 5 },
  };
  const items = projectConversationHistory([
    entry('tool/call', 1, { callId: 'call-done', name: 'run_task', arguments: '{"task_id":"task-z"}' }),
    entry('tool/result', 2, {
      message: {
        source: { kind: 'tool', callId: 'call-done' },
        content: [{ type: 'tool-result', toolCallId: 'call-done', content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false }],
      },
    }),
  ]);

  assert.equal(items[0].toolState, 'done');
});

test('turn projection keeps missing telemetry absent instead of fabricating zeros', () => {
  const turns = projectConversationTurns([
    entry('turn/start', 1, { turn: 4 }),
    entry('assistant/message', 2, { turn: 4, step: 1, message: { content: [{ type: 'text', text: '无遥测' }] } }),
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].id, 'turn-4');
  assert.equal(turns[0].running, true, 'no turn/end means the turn is still running');
  assert.equal(turns[0].endedAt, undefined);
  assert.equal(turns[0].inputTokens, undefined);
  assert.equal(turns[0].outputTokens, undefined);
  assert.equal(turns[0].outputTps, undefined, 'throughput needs a paired generation duration');
  // Only a completed turn carries a final item.
  assert.equal(turns[0].finalItemId, undefined);
  assert.equal(turns[0].dispatchCount, 0);
});

test('a cancelled turn keeps its boundaries without claiming a final item', () => {
  const turns = projectConversationTurns([
    entry('turn/start', 1, { turn: 3 }),
    entry('assistant/message', 2, { turn: 3, step: 1, message: { content: [{ type: 'text', text: '被打断' }] } }),
    entry('turn/end', 3, { turn: 3, reason: { kind: 'cancelled' } }),
  ]);

  assert.equal(turns[0].endedAt, 1_700_000_000_003);
  assert.equal(turns[0].running, false);
  assert.equal(turns[0].finalItemId, undefined, 'only a completed turn exposes the final assistant body');
});

test('turn dispatch count counts task executions, not every run_task-alias tool call', () => {
  const turns = projectConversationTurns([
    entry('turn/start', 1, { turn: 1 }),
    entry('tool/call', 2, { turn: 1, callId: 'c1', name: 'Read', arguments: '{"path":"README.md"}' }),
    entry('tool/call', 3, { turn: 1, callId: 'c2', name: 'run_task', arguments: '{"task_id":"task-a"}' }),
    entry('tool/call', 4, { turn: 1, callId: 'c3', name: 'task_run', arguments: '{"task_id":"task-b"}' }),
    // The same task dispatched twice in one turn is two dispatches.
    entry('tool/call', 5, { turn: 1, callId: 'c4', name: 'run_task', arguments: '{"task_id":"task-a"}' }),
    entry('turn/end', 6, { turn: 1, reason: { kind: 'completed' } }),
  ]);

  assert.equal(turns[0].dispatchCount, 3);
});

test('projected items expose the observed step number', () => {
  const items = projectConversationHistory([
    entry('assistant/message', 1, { turn: 2, step: 3, message: { content: [{ type: 'text', text: '第三步' }] } }),
    entry('tool/call', 2, { turn: 2, step: 4, callId: 'c-9', name: 'Read', arguments: '{"path":"a/b.md"}' }),
  ]);

  assert.equal(items[0].step, 3);
  assert.equal(items[1].step, 4);
});

test('tool summaries describe the real DSH workspace-doc, task, and discovery aliases', () => {
  const items = projectConversationHistory([
    entry('tool/call', 1, { turn: 1, callId: 'c-read', name: 'Read', arguments: '{"path":"docs/plan.md"}' }),
    entry('tool/call', 2, { turn: 1, callId: 'c-docs', name: 'list_workspace_docs', arguments: '{"directory":"docs"}' }),
    entry('tool/call', 3, { turn: 1, callId: 'c-doc-read', name: 'read_workspace_doc', arguments: '{"path":"docs/plan.md"}' }),
    entry('tool/call', 4, { turn: 1, callId: 'c-describe', name: 'describe_task', arguments: '{"task_id":"commit"}' }),
    entry('tool/call', 5, { turn: 1, callId: 'c-list', name: 'list_task', arguments: '{}' }),
    entry('tool/call', 6, { turn: 1, callId: 'c-projects', name: 'list_projects', arguments: '{}' }),
    entry('tool/call', 7, { turn: 1, callId: 'c-runtimes', name: 'list_runtimes', arguments: '{"task_id":"commit"}' }),
    entry('tool/call', 8, { turn: 1, callId: 'c-run', name: 'run_task', arguments: '{"task_id":"task-abc"}' }),
  ]);

  assert.equal(items[0].toolSummary, '读取文件 docs/plan.md');
  assert.equal(items[1].toolSummary, '列出 docs');
  assert.equal(items[2].toolSummary, '读文档 docs/plan.md');
  assert.equal(items[3].toolSummary, '查看任务定义 commit');
  assert.equal(items[4].toolSummary, '列出任务');
  assert.equal(items[5].toolSummary, '列出项目');
  assert.equal(items[6].toolSummary, '列出运行时 commit');
  assert.equal(items[7].toolSummary, '运行任务 task-abc', 'deterministic fallback before any display name is observed');
});

test('a run_task summary uses the task display name observed from a prior list result', () => {
  const items = projectConversationHistory([
    entry('tool/call', 1, { turn: 1, callId: 'c-list', name: 'list_task', arguments: '{}' }),
    at(2, toolResult('c-list', JSON.stringify({ tasks: [{ name: 'task-abc', display_name: '夜间构建' }] }))),
    entry('tool/call', 3, { turn: 1, callId: 'c-run', name: 'run_task', arguments: '{"task_id":"task-abc"}' }),
  ]);

  const list = items.find((item) => item.id === 'tool-c-list');
  const run = items.find((item) => item.id === 'tool-c-run');
  // The list summary itself is unchanged: at that point no display name was known.
  assert.equal(list?.toolSummary, '列出任务');
  assert.equal(run?.toolSummary, '运行任务 夜间构建');
});

test('document links carry a heading title and bounded path metadata without raw HTML', () => {
  const items = projectConversationHistory([
    entry('tool/call', 1, { turn: 1, callId: 'c-docs', name: 'read_workspace_doc', arguments: '{"path":"docs/plan.md"}' }),
    at(2, toolResult('c-docs', '# 发布计划\n\ndocs/plan.md\ndocs/other.md')),
  ]);

  assert.deepEqual(items[0].documentLinks, [
    { title: '发布计划', path: 'docs/plan.md' },
    { title: '发布计划', path: 'docs/other.md' },
  ]);
});

test('a workspace doc result reporting an explicit path keeps it as a reference', () => {
  const items = projectConversationHistory([
    entry('tool/call', 1, { turn: 1, callId: 'c-doc', name: 'read_workspace_doc', arguments: '{"path":"docs/plan.md"}' }),
    at(2, toolResult('c-doc', JSON.stringify({ path: 'docs/plan.md', content: '正文' }))),
  ]);

  assert.deepEqual(items[0].documentLinks, [{ title: 'docs/plan.md', path: 'docs/plan.md' }]);
});

test('a document result without a visible heading falls back to the exact path', () => {
  const items = projectConversationHistory([
    entry('tool/call', 1, { turn: 1, callId: 'c-docs', name: 'list_workspace_docs', arguments: '{"directory":"docs"}' }),
    at(2, toolResult('c-docs', '见 docs/guide.md 与 <html><body>markup</body></html>')),
  ]);

  assert.deepEqual(items[0].documentLinks, [{ title: 'docs/guide.md', path: 'docs/guide.md' }]);
});

test('a failed document read exposes no document links', () => {
  const items = projectConversationHistory([
    entry('tool/call', 1, { turn: 1, callId: 'c-docs', name: 'read_workspace_doc', arguments: '{}' }),
    at(2, toolResult('c-docs', '# 标题\ndocs/plan.md', true)),
  ]);

  assert.equal(items[0].toolState, 'failed');
  assert.equal(items[0].documentLinks, undefined);
});

test('projectConversation returns matching items and turns from one pass', () => {
  const entries = [
    entry('turn/start', 1, { turn: 1 }),
    entry('assistant/message', 2, { turn: 1, step: 1, message: { content: [{ type: 'text', text: '一段回复' }] } }),
    entry('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
  ];

  const projection = projectConversation(entries);
  assert.deepEqual(projection.items, projectConversationHistory(entries));
  assert.deepEqual(projection.turns, projectConversationTurns(entries));
});
