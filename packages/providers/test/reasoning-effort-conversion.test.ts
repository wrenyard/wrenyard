import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltinCatalog, type ProviderDefinition } from '../src/index.ts';
import { Catalog } from '../src/base/catalog.ts';
import { createCodeBuddyModels } from '../src/codebuddy/models.ts';

const catalog = createBuiltinCatalog();
const translate = (provider: string, model: string, effort: 'none' | 'medium' | 'high', protocol: 'openai_chat' | 'openai_responses' | 'anthropic_messages') =>
  catalog.provider(provider)!.convertReasoningEffort(model, effort, protocol);

test('OpenAI emits the exact protocol field and rejects Anthropic transport', () => {
  assert.deepEqual(translate('openai', 'gpt-6.1-sol', 'high', 'openai_chat'), { reasoning_effort: 'high' });
  assert.deepEqual(translate('openai', 'gpt-6.1-sol', 'high', 'openai_responses'), { reasoning: { effort: 'high' } });
  assert.throws(() => translate('openai', 'gpt-6.1-sol', 'high', 'anthropic_messages'), /unsupported/);
});

test('DeepSeek none disables thinking and enabled efforts keep the protocol field', () => {
  assert.deepEqual(translate('deepseek', 'deepseek-flash', 'none', 'openai_chat'), { thinking: { type: 'disabled' } });
  assert.deepEqual(translate('deepseek', 'deepseek-pro', 'high', 'openai_chat'), { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  assert.deepEqual(translate('deepseek', 'deepseek-pro', 'high', 'openai_responses'), { reasoning: { effort: 'high' } });
  assert.deepEqual(translate('deepseek', 'deepseek-pro', 'high', 'anthropic_messages'), { thinking: { type: 'enabled' }, output_config: { effort: 'high' } });
  assert.ok(catalog.provider('deepseek')!.models.every(model => model.reasoningEfforts.includes('none')));
});

test('Kimi uses a disable switch, Messages effort and Responses effort separately', () => {
  assert.deepEqual(translate('kimi-coding', 'kimi-k2.8', 'none', 'openai_chat'), { thinking: { type: 'disabled' } });
  assert.deepEqual(translate('kimi-coding', 'k3', 'high', 'openai_chat'), { reasoning_effort: 'high' });
  assert.deepEqual(translate('kimi-coding', 'k3', 'high', 'anthropic_messages'), { thinking: { type: 'enabled' }, output_config: { effort: 'high' } });
  assert.deepEqual(translate('kimi-coding', 'k3', 'high', 'openai_responses'), { reasoning: { effort: 'high' } });
});

test('MiniMax M3 toggle and M3.1 effort controls produce exact separate payloads', () => {
  for (const protocol of ['openai_chat', 'anthropic_messages'] as const) {
    assert.deepEqual(translate('minimax', 'MiniMax-M3', 'none', protocol), { thinking: { type: 'disabled' } });
    assert.deepEqual(translate('minimax', 'MiniMax-M3', 'medium', protocol), { thinking: { type: 'adaptive' } });
  }
  assert.deepEqual(translate('minimax-coding', 'MiniMax-M3.1-Flash-Preview', 'high', 'openai_chat'), { reasoning_effort: 'high' });
  assert.deepEqual(translate('minimax-coding', 'MiniMax-M3.1-Flash-Preview', 'high', 'anthropic_messages'), { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
  assert.deepEqual(translate('minimax-coding', 'MiniMax-M3.1-Flash-Preview', 'high', 'openai_responses'), { reasoning: { effort: 'high' } });
});

test('Zhipu separates GLM-5.2 disable from each effort transport', () => {
  assert.deepEqual(translate('zhipu', 'glm-5.2', 'none', 'openai_chat'), { thinking: { type: 'disabled' } });
  assert.deepEqual(translate('zhipu-coding', 'glm-5.3', 'high', 'openai_chat'), { reasoning_effort: 'high' });
  assert.deepEqual(translate('zhipu-coding', 'glm-5.3', 'high', 'anthropic_messages'), { thinking: { type: 'enabled' }, output_config: { effort: 'high' } });
  assert.deepEqual(translate('zhipu-coding', 'glm-5.3', 'high', 'openai_responses'), { reasoning: { effort: 'high' } });
});

test('Anthropic adaptive effort stays outside thinking; Haiku uses only its budget', () => {
  assert.deepEqual(translate('anthropic', 'claude-opus-5-5', 'high', 'anthropic_messages'), { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
  assert.throws(() => translate('anthropic', 'claude-opus-5-5', 'none', 'anthropic_messages'), /cannot disable/);
  assert.deepEqual(translate('anthropic', 'claude-haiku-4-5-20251001', 'medium', 'anthropic_messages'), { thinking: { type: 'enabled', budget_tokens: 8192 } });
  assert.deepEqual(translate('anthropic', 'claude-haiku-4-5-20251001', 'none', 'anthropic_messages'), { thinking: { type: 'disabled' } });
  assert.throws(() => translate('anthropic', 'claude-opus-5-5', 'high', 'openai_chat'), /Messages/);
});

test('every dispatchable built-in client/route has a non-empty route subset', () => {
  for (const provider of catalog.providers()) for (const model of provider.models) for (const client of catalog.clients()) {
    try { catalog.resolveRun(client.id, provider.id, model.id); } catch { continue; }
    const subset = catalog.reasoningEfforts(client.id, provider.id, model.id);
    assert.ok(subset.length > 0);
    assert.ok(subset.every(level => model.reasoningEfforts.includes(level)));
    for (const level of subset) assert.equal(catalog.resolveRun(client.id, provider.id, model.id, level).reasoningEffort, level);
  }
});

test('only a Gateway header-forwarding client inherits an unmapped route ladder', () => {
  const runtime = createCodeBuddyModels([{ id: 'claude-opus-5-5' }]);
  const provider = { ...runtime.definition, reasoningEffortMappings: {} } as ProviderDefinition;
  const isolated = new Catalog();
  isolated.registerProvider(provider);
  isolated.registerClient({ id: 'forward', forwardsGatewayReasoningEffort: true, gatewayProtocols: ['openai_chat'] });
  isolated.registerClient({ id: 'unmapped', gatewayProtocols: ['openai_chat'] });
  isolated.registerClient({ id: 'codebuddy', forwardsGatewayReasoningEffort: true, gatewayProtocols: ['openai_chat'] });
  assert.equal(isolated.resolveRun('forward', 'codebuddy', 'claude-opus-5-5', 'medium').reasoningEffort, 'high');
  assert.throws(() => isolated.resolveRun('unmapped', 'codebuddy', 'claude-opus-5-5', 'high'), /no reasoning-effort mapping/);
  assert.throws(() => isolated.resolveRun('codebuddy', 'codebuddy', 'claude-opus-5-5', 'high'), /no reasoning-effort mapping/);
});

test('Cursor uses listed native suffixes and its fixed Composer model', () => {
  for (const [model, effort, wire] of [
    ['gpt-5.6-sol', 'none', 'gpt-5.6-sol-none'],
    ['gpt-5.6-luna', 'max', 'gpt-5.6-luna-max'],
    ['kimi-k3', 'max', 'kimi-k3-max'],
    ['claude-opus-5-5', 'xhigh', 'claude-opus-5-5-xhigh'],
    ['claude-fable-5-1', 'high', 'claude-fable-5-1-thinking-high'],
    ['grok-4.6', 'low', 'cursor-grok-4.6-low'],
    ['composer-2.5', 'high', 'composer-2.5'],
  ] as const) assert.equal(catalog.resolveRun('cursor', 'cursor', model, effort).upstreamModel, wire);
});

test('runtime CodeBuddy routes send the accepted disable form without an effort field', () => {
  const fixedHighIds = ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'hunyuan-hy3', 'hunyuan-hy4-preview'];
  const ids = [...fixedHighIds, 'claude-opus-5-5', 'gpt-6-astra', 'glm-5.3', 'glm-5.3-flash', 'kimi-k3'];
  const { definition } = createCodeBuddyModels(ids.map(id => ({ id })));
  const runtimeCatalog = new Catalog();
  runtimeCatalog.registerProvider(definition);
  for (const client of catalog.clients()) runtimeCatalog.registerClient(client);
  for (const model of definition.models) {
    const enabled = fixedHighIds.includes(model.id) ? ['high'] : ['low', 'high', 'max'];
    assert.deepEqual(model.reasoningEfforts, ['none', ...enabled]);
    assert.deepEqual(definition.convertReasoningEffort(model.id, 'none', 'openai_chat'), { thinking: { type: 'disabled' } });
    assert.deepEqual(definition.convertReasoningEffort(model.id, 'high', 'openai_chat'), { reasoning_effort: 'high' });
    for (const client of ['opencode', 'dsh']) {
      assert.equal(runtimeCatalog.resolveRun(client, 'codebuddy', model.id, 'none').reasoningEffort, 'none');
    }
    assert.deepEqual(runtimeCatalog.reasoningEfforts('codebuddy', 'codebuddy', model.id), enabled);
  }
});
