import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLIENT_TABS,
  buildClientPageModel,
  renderClientPageMarkup,
  renderClientPlanPreview,
} from '../src/renderer/client-page.js';

test('client page exposes five real-client tabs in fixed order mapped to four configuration groups', () => {
  assert.deepEqual(CLIENT_TABS.map((tab) => tab.id), ['claude-app', 'claude-code', 'codex-app', 'codex-cli', 'grok-build']);
  assert.deepEqual(
    CLIENT_TABS.map((tab) => tab.clientId),
    ['claude-app', 'claude-code', 'codex-shared', 'codex-shared', 'grok-build'],
  );

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
  // The codex-shared card still groups both surfaces for the backend configuration.
  const codex = model.cards.find((card) => card.id === 'codex-shared');
  assert.equal(codex?.surfaces.length, 2);
  assert.equal(codex?.surfaces[0].status, '待独立验收');
  assert.equal(codex?.surfaces[1].status, '支持');
  assert.equal(codex?.primaryAction, '调整模型');
  assert.equal(codex?.connectionMode, '切换式');
  assert.equal(model.cards.find((card) => card.id === 'grok-build')?.connectionMode, '加法式');
});

test('client markup renders one tablist and exactly one active tabpanel that keeps plan/apply hooks', () => {
  const model = buildClientPageModel({
    surfaces: [
      { id: 'codex-app', label: 'Codex App', installed: true, compatibility: 'supported', version: '26.901' },
      { id: 'codex-cli', label: 'Codex CLI', installed: true, compatibility: 'supported', version: '0.153.0' },
    ],
    configurations: [{ clientId: 'codex-shared', state: 'connected', configuredModels: ['openai/sol'] }],
    models: [
      { id: 'sol', publicId: 'openai/sol', provider: 'openai', displayName: 'Sol', protocols: ['openai_responses'] },
    ],
  });

  const markup = renderClientPageMarkup(model, 'codex-app');
  assert.equal((markup.match(/role="tablist"/g) ?? []).length, 1);
  assert.equal((markup.match(/role="tabpanel"/g) ?? []).length, 1);
  assert.equal((markup.match(/data-client-tab-target=/g) ?? []).length, 5);

  // Active tab and panel are linked through aria-controls/aria-labelledby.
  assert.match(
    markup,
    /<button[^>]+id="client-tab-codex-app"[^>]*aria-selected="true"[^>]*aria-controls="client-tabpanel-codex-app"/,
  );
  assert.match(
    markup,
    /<div[^>]+id="client-tabpanel-codex-app"[^>]*role="tabpanel"[^>]*aria-labelledby="client-tab-codex-app"[^>]*data-client-id="codex-shared"/,
  );
  // Inactive tabs keep roving tabindex off the tab stop.
  assert.match(markup, /id="client-tab-codex-cli"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
  assert.match(markup, /id="client-tab-claude-app"[^>]*aria-selected="false"[^>]*tabindex="-1"/);

  // The active panel alone carries the existing configuration controls.
  assert.match(markup, /data-client-model="openai\/sol"/);
  assert.match(markup, /data-client-default="openai\/sol"/);
  assert.match(markup, /name="codex-shared-default-model"/);
  assert.match(markup, /data-client-action="primary"/);

  // Codex App and Codex CLI are separate tabs, each rendering its own panel and surface.
  const cliMarkup = renderClientPageMarkup(model, 'codex-cli');
  assert.match(cliMarkup, /id="client-tabpanel-codex-cli"[^>]*data-client-id="codex-shared"/);
  assert.match(markup, /data-surface-id="codex-app"/);
  assert.doesNotMatch(markup, /data-surface-id="codex-cli"/);
  assert.match(cliMarkup, /data-surface-id="codex-cli"/);
  assert.doesNotMatch(cliMarkup, /data-surface-id="codex-app"/);
});

test('each tab carries client-specific copy; Codex tabs state that shared config affects the other surface', () => {
  const model = buildClientPageModel({ surfaces: [], configurations: [], models: [] });
  const claudeApp = renderClientPageMarkup(model, 'claude-app');
  assert.match(claudeApp, /第三方/);
  assert.match(claudeApp, /完全重启/);
  const claudeCode = renderClientPageMarkup(model, 'claude-code');
  assert.match(claudeCode, /自动发现/);
  assert.match(claudeCode, /新开会话/);
  const codexApp = renderClientPageMarkup(model, 'codex-app');
  assert.match(codexApp, /仅使用 Responses 协议/);
  assert.match(codexApp, /Codex CLI/);
  assert.match(codexApp, /共享同一配置/);
  assert.match(codexApp, /影响 CLI/);
  const codexCli = renderClientPageMarkup(model, 'codex-cli');
  assert.match(codexCli, /仅使用 Responses 协议/);
  assert.match(codexCli, /Codex App/);
  assert.match(codexCli, /共享同一配置/);
  assert.match(codexCli, /影响 App/);
  const grok = renderClientPageMarkup(model, 'grok-build');
  assert.match(grok, /加法式/);
  assert.match(grok, /官方模型/);
});

test('client markup escapes surface labels, model ids and surface details', () => {
  const model = buildClientPageModel({
    surfaces: [
      { id: 'codex-app', label: 'Codex <App>', installed: true, compatibility: 'supported', version: 'x', detail: '<gateway>' },
    ],
    configurations: [{ clientId: 'codex-shared', state: 'connected', configuredModels: ['openai/<sol>'] }],
    models: [
      { id: 'sol', publicId: 'openai/<sol>', provider: 'openai', displayName: 'Sol <X>', protocols: ['openai_responses'] },
    ],
  });
  const markup = renderClientPageMarkup(model, 'codex-app');
  assert.match(markup, /Codex &lt;App&gt;/);
  assert.match(markup, /openai\/&lt;sol&gt;/);
  assert.match(markup, /Sol &lt;X&gt;/);
  assert.doesNotMatch(markup, /<App>/);
  assert.doesNotMatch(markup, /<gateway>/);
  assert.doesNotMatch(markup, /<sol>/);
});

test('Codex and Grok empty states name the missing capability', () => {
  const empty = { surfaces: [], configurations: [], models: [] };
  const codexApp = renderClientPageMarkup(buildClientPageModel(empty), 'codex-app');
  assert.match(codexApp, /当前没有已配置的 Responses 模型。/);
  assert.doesNotMatch(codexApp, /当前没有可用于此客户端的已配置 Gateway 模型。/);
  const grok = renderClientPageMarkup(buildClientPageModel(empty), 'grok-build');
  assert.match(grok, /当前没有可用于此客户端的已配置 Gateway 模型。/);
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

test('plan preview escapes file paths and models while hiding digests', () => {
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
