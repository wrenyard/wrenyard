import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltinCatalog, resolveBuiltinDispatchPlans } from '../src/index.ts';

test('CodeBuddy keeps native routing and exposes its four gateway models', () => {
  const catalog = createBuiltinCatalog();
  assert.equal(catalog.resolveRun('codebuddy', 'codebuddy', 'deepseek-v4-flash').mode, 'native');
  assert.equal(catalog.resolveRun('dsh', 'codebuddy', 'deepseek-v4-flash').protocol, 'openai_chat');
  assert.deepEqual(
    catalog.listGatewayModels('openai_chat').filter((entry) => entry.provider === 'codebuddy').map((entry) => entry.id),
    ['deepseek-v4-flash', 'deepseek-v4-pro', 'hy4-preview-ioa', 'kimi-k2.6'],
  );
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
