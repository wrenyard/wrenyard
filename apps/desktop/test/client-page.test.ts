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
