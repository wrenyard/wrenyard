import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltinCatalog,
  createBuiltinProviderRuntime,
  deriveTaskDispatchPlans,
} from '../src/index.ts';

function managedRuntime(keys: Record<string, string>) {
  return createBuiltinProviderRuntime({
    env: { XDG_DATA_HOME: '/data' },
    home: '/home',
    readFile: async () =>
      JSON.stringify(Object.fromEntries(Object.entries(keys).map(([id, key]) => [id, { type: 'api', key }]))),
  });
}

test('Zen and OpenRouter free models carry the free entitlement and a reference tariff; Go models are nonzero', () => {
  const catalog = createBuiltinCatalog();
  const assertFree = (provider: string, modelId: string): void => {
    const model = catalog.provider(provider)!.models.find((entry) => entry.id === modelId)!;
    // `free` is a provider-scoped entitlement; the list tariff stays a
    // reference constant rather than a fabricated zero.
    assert.equal(model.free, true, `${provider}/${modelId} must be flagged free`);
    assert.ok(model.pricing[1] > 0, `${provider}/${modelId} keeps a reference list tariff`);
    assert.ok(model.intelligence, `${provider}/${modelId} must still carry a configured tier`);
  };
  assertFree('opencode-zen', 'mimo-v2.5-free');
  assertFree('opencode-zen', 'ling-3.0-flash-fin-free');
  assertFree('opencode-zen', 'big-pickle');
  assertFree('opencode-zen', 'union-alpha');
  assertFree('opencode-zen', 'nemotron-3-ultra-free');
  assertFree('opencode-zen', 'nemotron-3.5-lightning-free');
  assertFree('openrouter', 'nex-agi/nex-n2.5-mini:free');
  assertFree('openrouter', 'nex-agi/nex-n2.5-pro:free');
  assertFree('openrouter', 'cohere/north-mini-code:free');
  assertFree('openrouter', 'inclusionai/ling-3.0-flash-vl:free');
  assertFree('openrouter', 'inclusionai/ling-3.0-flash-sante:free');
  assertFree('openrouter', 'inclusionai/ling-3.0-flash-fin:free');
  assertFree('openrouter', 'qwen/qwen3.8-27b:free');
  assertFree('openrouter', 'dots-studio/dots-3-note-preview:free');
  assertFree('openrouter', 'liquid/lfm-2.5-2.6b:free');
  assertFree('openrouter', 'nvidia/nemotron-3.5-lightning:free');
  assertFree('openrouter', 'thinkingmachines/inkling-small:free');
  assertFree('openrouter', 'thinkingmachines/inkling:free');
  assertFree('openrouter', 'poolside/laguna-s-2.1:free');
  assertFree('openrouter', 'poolside/laguna-xs-2.1:free');
  assertFree('openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free');
  assertFree('openrouter', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free');
  assertFree('openrouter', 'google/gemma-4-26b-a4b-it:free');
  assertFree('openrouter', 'google/gemma-4-31b-it:free');
  assertFree('openrouter', 'nvidia/nemotron-3-super-120b-a12b:free');

  // Paid Zen models are priced by the shared catalog metadata.
  const zen = catalog.provider('opencode-zen')!;
  const zenPrices = Object.fromEntries(zen.models.map((entry) => [entry.id, entry.pricing]));
  assert.deepEqual(zenPrices['glm-5.3'], [0.26, 1.4, 4.4]);
  assert.deepEqual(zenPrices['kimi-k3'], [0.30, 3, 15]);

  const go = catalog.provider('opencode-go')!;
  const prices = Object.fromEntries(go.models.map((entry) => [entry.id, entry.pricing!]));
  assert.deepEqual(prices['glm-5.3-flash'], [0.03, 0.15, 0.50]);
  assert.deepEqual(prices['glm-5.3'], [0.26, 1.4, 4.4]);
  assert.deepEqual(prices['deepseek-flash'], [0.006, 0.3, 1.2]);
  assert.deepEqual(prices['hy3'], [0.035, 0.14, 0.58]);
  for (const id of Object.keys(prices)) {
    assert.ok(
      prices[id][1] > 0 || prices[id][2] > 0,
      `${id} Go price must be nonzero`,
    );
  }
});

test('free supply is granted only to the exact authenticated allowlists for Zen and OpenRouter', async () => {
  const catalog = createBuiltinCatalog();
  const runtime = managedRuntime({
    'opencode-zen': 'zen-key',
    openrouter: 'or-key',
    'opencode-go': 'go-key',
  });
  const zen = catalog.provider('opencode-zen')!;
  const or = catalog.provider('openrouter')!;
  const go = catalog.provider('opencode-go')!;
  const zenCred = await runtime.credential(zen);
  const orCred = await runtime.credential(or);
  const goCred = await runtime.credential(go);
  assert.ok(zenCred && orCred && goCred);

  const zenFact = runtime.freeSupply?.(zen, 'mimo-v2.5-free', zenCred!);
  assert.ok(zenFact && zenFact.confirmedFree);
  assert.equal(zenFact!.source, 'opencode-zen.catalog');
  assert.equal(zenFact!.ruleId, 'opencode-zen.free_model_confirmed_free');
  const zenFact2 = runtime.freeSupply?.(zen, 'ling-3.0-flash-fin-free', zenCred!);
  assert.ok(zenFact2 && zenFact2.confirmedFree && zenFact2.ruleId === 'opencode-zen.free_model_confirmed_free');

  const orFact = runtime.freeSupply?.(or, 'nex-agi/nex-n2.5-mini:free', orCred!);
  assert.ok(orFact && orFact.confirmedFree);
  assert.equal(orFact!.source, 'openrouter.catalog');
  assert.equal(orFact!.ruleId, 'openrouter.free_model_confirmed_free');
  const orFact2 = runtime.freeSupply?.(or, 'cohere/north-mini-code:free', orCred!);
  assert.ok(orFact2 && orFact2.confirmedFree && orFact2.ruleId === 'openrouter.free_model_confirmed_free');

  // Arbitrary :free names are never granted.
  assert.equal(runtime.freeSupply?.(zen, 'random-model:free', zenCred!), undefined);
  // opencode-go is paid and never free.
  assert.equal(runtime.freeSupply?.(go, 'glm-5.3-flash', goCred!), undefined);
  assert.equal(runtime.freeSupply?.(go, 'hy3', goCred!), undefined);
  // Undeclared/paid models are not free on the free providers.
  assert.equal(runtime.freeSupply?.(zen, 'glm-5.3-flash', zenCred!), undefined);
  assert.equal(runtime.freeSupply?.(or, 'glm-5.3', orCred!), undefined);
});

test('free supply is denied for anonymous, missing, and non-managed credentials', async () => {
  const catalog = createBuiltinCatalog();
  const zen = catalog.provider('opencode-zen')!;
  const runtime = managedRuntime({});
  // Anonymous (empty) credential.
  assert.equal(runtime.freeSupply?.(zen, 'mimo-v2.5-free', { value: '' }), undefined);
  // Missing credential object.
  assert.equal(runtime.freeSupply?.(zen, 'mimo-v2.5-free', undefined as never), undefined);
  // A non-managed provider never grants the free-pool models.
  const cb = catalog.provider('codebuddy')!;
  assert.equal(runtime.freeSupply?.(cb, 'mimo-v2.5-free', { value: 'x' }), undefined);
});

test('OpenRouter slash+colon model resolves as a gateway and never as a paid OpenCode fallback', () => {
  const catalog = createBuiltinCatalog();
  const resolved = catalog.resolveGatewayModel('openai_chat', 'openrouter/nex-agi/nex-n2.5-mini:free');
  assert.equal(resolved.provider.id, 'openrouter');
  assert.equal(resolved.model.id, 'nex-agi/nex-n2.5-mini:free');
  assert.equal(resolved.upstreamModel, 'nex-agi/nex-n2.5-mini:free');

  // OpenCode routes the free model as a gateway (no native/paid mode).
  const plan = catalog.resolveRun('opencode', 'openrouter', 'nex-agi/nex-n2.5-mini:free');
  assert.equal(plan.mode, 'gateway');
  assert.equal(plan.protocol, 'openai_chat');

  const plans = deriveTaskDispatchPlans(catalog);
  // No OpenRouter profile is ever classified as a paid native route.
  for (const key of Object.keys(plans)) {
    if (key.startsWith('openrouter/')) assert.equal(plans[key].mode, 'gateway', `${key} must route as gateway, never paid native`);
  }
});

test('Zen free models are excluded from the public gateway but paid Zen models stay gateway-usable', () => {
  const catalog = createBuiltinCatalog();
  const gatewayChat = catalog.listGatewayModels('openai_chat', (provider) => provider.id === 'opencode-zen');
  const ids = gatewayChat.map((entry) => entry.id);
  for (const freeId of [
    'mimo-v2.5-free',
    'ling-3.0-flash-fin-free',
    'big-pickle',
    'union-alpha',
    'nemotron-3-ultra-free',
    'nemotron-3.5-lightning-free',
  ]) {
    assert.ok(!ids.includes(freeId), `free Zen model ${freeId} must not appear in the public gateway directory`);
    assert.throws(() => catalog.resolveGatewayModel('openai_chat', `opencode-zen/${freeId}`), /not available through the gateway/);
  }
  // Paid Zen models remain gateway-usable.
  assert.ok(ids.includes('glm-5.3'));
  assert.ok(ids.includes('kimi-k3'));
  assert.equal(catalog.resolveGatewayModel('openai_chat', 'opencode-zen/glm-5.3').model.id, 'glm-5.3');

  // The exact OpenCode client can still resolve a free Zen model directly.
  const plan = catalog.resolveRun('opencode', 'opencode-zen', 'mimo-v2.5-free');
  assert.equal(plan.mode, 'native');
  // Any other client is rejected for a restricted free model.
  assert.throws(() => catalog.resolveRun('codebuddy', 'opencode-zen', 'mimo-v2.5-free'), /is not available on client codebuddy/);
});

test('OpenCode routes free-pool Go models as gateways without a paid fallback', () => {
  const catalog = createBuiltinCatalog();
  const plans = deriveTaskDispatchPlans(catalog);
  for (const modelId of ['glm-5.3-flash', 'glm-5.3', 'deepseek-flash', 'hy3']) {
    const plan = plans[`opencode-go/${modelId}:oc`];
    assert.ok(plan, `opencode-go/${modelId} must be an OpenCode task target`);
    assert.equal(plan.mode, 'gateway');
    assert.equal(plan.protocol, 'openai_chat');
  }
});
