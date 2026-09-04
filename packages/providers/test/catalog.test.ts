import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltinCatalog, resolveBuiltinDispatchPlans } from '../src/index.ts';

test('CodeBuddy keeps native routing and exposes every confirmed gateway model', () => {
  const catalog = createBuiltinCatalog();
  assert.equal(catalog.resolveRun('codebuddy', 'codebuddy', 'deepseek-v4-flash').mode, 'native');
  const modelIds = [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'hy4-preview',
    'minimax-m3',
    'kimi-k3',
    'glm-5.3',
    'glm-5.3-flash',
  ];
  assert.deepEqual(
    catalog.listGatewayModels('openai_chat').filter((entry) => entry.provider === 'codebuddy').map((entry) => entry.id),
    modelIds,
  );
  for (const modelId of modelIds) {
    assert.equal(catalog.resolveRun('dsh', 'codebuddy', modelId).protocol, 'openai_chat');
    assert.equal(catalog.resolveGatewayModel('openai_chat', `codebuddy/${modelId}`).upstreamModel, modelId);
  }
  const legacy = catalog.resolveGatewayModel('openai_chat', 'codebuddy/hy4-preview-ioa');
  assert.equal(legacy.model.id, 'hy4-preview');
  assert.equal(legacy.publicId, 'codebuddy/hy4-preview');
});

test('daemon dispatch plans are resolved by the TypeScript catalog', () => {
  const plans = resolveBuiltinDispatchPlans(createBuiltinCatalog());
  assert.deepEqual(plans['cc-kimi'], {
    client: 'claude', provider: 'kimi-coding', model: 'k3', mode: 'gateway', protocol: 'anthropic_messages',
  });
  assert.deepEqual(plans['codex-sol'], {
    client: 'codex', provider: 'codex', model: 'gpt-5.6-sol', mode: 'native',
  });
  assert.deepEqual(plans['cb-minimax'], {
    client: 'codebuddy', provider: 'codebuddy', model: 'minimax-m3', mode: 'native',
  });
  assert.deepEqual(plans['cb-hy'], {
    client: 'codebuddy', provider: 'codebuddy', model: 'hy4-preview', mode: 'native',
  });
  assert.deepEqual(plans['cb-kimi'], {
    client: 'codebuddy', provider: 'codebuddy', model: 'kimi-k3', mode: 'native',
  });
  assert.deepEqual(plans['cb-glm'], {
    client: 'codebuddy', provider: 'codebuddy', model: 'glm-5.3', mode: 'native',
  });
  assert.deepEqual(plans['cb-glmf'], {
    client: 'codebuddy', provider: 'codebuddy', model: 'glm-5.3-flash', mode: 'native',
  });
});

test('dispatch plans contain no provider endpoint or credential metadata', () => {
  const encoded = JSON.stringify(createBuiltinCatalog().resolveRun('dsh', 'codebuddy', 'hy4-preview-ioa'));
  assert.doesNotMatch(encoded, /https:|endpoint|authScheme|credentialResolver/);
  assert.doesNotMatch(encoded, /-ioa/u);
  assert.match(encoded, /"model":"hy4-preview"/u);
  assert.match(encoded, /"mode":"gateway"/);
});
