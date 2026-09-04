import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltinCatalog, resolveBuiltinDispatchPlans } from '../src/index.ts';

test('CodeBuddy keeps native routing and exposes every confirmed gateway model', () => {
  const catalog = createBuiltinCatalog();
  assert.equal(catalog.resolveRun('codebuddy', 'codebuddy', 'deepseek-v4-flash').mode, 'native');
  const modelIds = [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'hy4-preview-ioa',
    'kimi-k2.6',
    'minimax-m3',
    'minimax-m2.7',
    'kimi-k2.7',
    'hy3-preview',
  ];
  assert.deepEqual(
    catalog.listGatewayModels('openai_chat').filter((entry) => entry.provider === 'codebuddy').map((entry) => entry.id),
    modelIds,
  );
  for (const modelId of modelIds) {
    assert.equal(catalog.resolveRun('dsh', 'codebuddy', modelId).protocol, 'openai_chat');
    assert.equal(catalog.resolveGatewayModel('openai_chat', `codebuddy/${modelId}`).upstreamModel, modelId);
  }
});

test('daemon dispatch plans are resolved by the TypeScript catalog', () => {
  const plans = resolveBuiltinDispatchPlans(createBuiltinCatalog());
  assert.deepEqual(plans['cc-kimi'], {
    client: 'claude', provider: 'kimi-coding', model: 'k3', mode: 'gateway', protocol: 'anthropic_messages',
  });
  assert.deepEqual(plans['codex-sol'], {
    client: 'codex', provider: 'codex', model: 'gpt-5.6-sol', mode: 'native',
  });
});

test('dispatch plans contain no provider endpoint or credential metadata', () => {
  const encoded = JSON.stringify(createBuiltinCatalog().resolveRun('dsh', 'codebuddy', 'hy4-preview-ioa'));
  assert.doesNotMatch(encoded, /https:|endpoint|authScheme|credentialResolver/);
  assert.match(encoded, /"mode":"gateway"/);
});
