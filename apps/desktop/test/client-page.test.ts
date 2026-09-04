import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildClientPageModel, renderClientPageMarkup, renderClientPlanPreview } from '../src/renderer/client-page.js';

test('client page keeps Codex App and CLI status separate while sharing one configuration card', () => {
  const model = buildClientPageModel({
    surfaces: [
      { id: 'codex-app', label: 'Codex App', installed: true, compatibility: 'needs-verification', version: '26.901' },
      { id: 'codex-cli', label: 'Codex CLI', installed: true, compatibility: 'supported', version: '0.153.0' },
      { id: 'grok-build', label: 'Grok Build', installed: true, compatibility: 'supported', version: '1.0.5' },
    ],
    configurations: [
      { clientId: 'codex-shared', state: 'needs-restart', configuredModels: ['openai/sol'] },
      { clientId: 'grok-build', state: 'connected', configuredModels: ['zhipu/glm'] },
    ],
    models: [],
  });
  const codex = model.cards.find((card) => card.id === 'codex-shared');
  assert.equal(codex?.surfaces.length, 2);
  assert.equal(codex?.surfaces[0].status, '待独立验收');
  assert.equal(codex?.surfaces[1].status, '支持');
  assert.equal(codex?.primaryAction, '调整模型');
  assert.equal(codex?.connectionMode, '切换式');
  assert.equal(model.cards.find((card) => card.id === 'grok-build')?.connectionMode, '加法式');
});

test('client page markup exposes cards and escapes paths, models and details', () => {
  const model = buildClientPageModel({
    surfaces: [{ id: 'claude-code', label: 'Claude <Code>', installed: true, compatibility: 'needs-upgrade', detail: '<upgrade>' }],
    configurations: [{ clientId: 'claude-code', state: 'conflict', configuredModels: ['anthropic/<opus>'] }],
    models: [],
  });
  const markup = renderClientPageMarkup(model);
  assert.match(markup, /data-client-id="codex-shared"/);
  assert.match(markup, /data-surface-id="codex-app"/);
  assert.match(markup, /Claude &lt;Code&gt;/);
  assert.doesNotMatch(markup, /<upgrade>/);
  assert.match(markup, /查看冲突/);

  const preview = renderClientPlanPreview({
    clientId: 'claude-code',
    operation: 'apply',
    files: [{ path: '/tmp/<settings>.json', digest: 'secret-digest', existed: true, changes: ['env.ANTHROPIC_BASE_URL'] }],
    models: ['anthropic/<opus>'],
    defaultModel: 'anthropic/<opus>',
    connectionMode: 'switching',
    effects: ['原生登录仍保留'],
    requiresRestart: ['claude-code'],
  });
  assert.match(preview, /连接预览/);
  assert.match(preview, /\/tmp\/&lt;settings&gt;\.json/);
  assert.match(preview, /anthropic\/&lt;opus&gt;/);
  assert.doesNotMatch(preview, /secret-digest/);
});

test('client model availability follows protocol intersection and Grok compatibility exclusions', () => {
  const model = buildClientPageModel({
    surfaces: [],
    configurations: [],
    models: [
      {
        id: 'k3', publicId: 'kimi-coding/k3', provider: 'kimi-coding', displayName: 'Kimi K3',
        protocols: ['anthropic_messages'], claudeFamily: false,
      },
      {
        id: 'glm', publicId: 'zhipu-coding/glm-5.3', provider: 'zhipu-coding', displayName: 'GLM-5.3',
        protocols: ['openai_chat', 'anthropic_messages'],
      },
      {
        id: 'deepseek', publicId: 'codebuddy/deepseek-v4-flash', provider: 'codebuddy', displayName: 'DeepSeek V4 Flash',
        protocols: ['openai_chat'],
      },
      {
        id: 'sol', publicId: 'openai/sol', provider: 'openai', displayName: 'Sol',
        protocols: ['openai_responses'],
      },
    ],
  });

  for (const clientId of ['claude-app', 'claude-code'] as const) {
    assert.deepEqual(
      model.cards.find((card) => card.id === clientId)?.availableModels.map((entry) => entry.publicId),
      ['kimi-coding/k3', 'zhipu-coding/glm-5.3'],
    );
  }
  assert.deepEqual(
    model.cards.find((card) => card.id === 'codex-shared')?.availableModels.map((entry) => entry.publicId),
    ['openai/sol'],
  );
  assert.deepEqual(
    model.cards.find((card) => card.id === 'grok-build')?.availableModels.map((entry) => entry.publicId),
    ['kimi-coding/k3', 'zhipu-coding/glm-5.3', 'openai/sol'],
  );
});

test('Codex empty state names the missing Responses capability', () => {
  const markup = renderClientPageMarkup(buildClientPageModel({ surfaces: [], configurations: [], models: [] }));
  const codexMarkup = markup.match(/<article class="client-card" data-client-id="codex-shared">([\s\S]*?)<\/article>/)?.[1] ?? '';
  assert.match(codexMarkup, /当前没有已配置的 Responses 模型。/);
  assert.doesNotMatch(codexMarkup, /当前没有可用于此客户端的已配置 Gateway 模型。/);
});
