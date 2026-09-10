import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltinCatalog,
  createBuiltinProviderRuntime,
  deriveTaskDispatchPlans,
} from '../src/index.ts';

function forgeManagedRuntime(keys: Record<string, string>) {
  return createBuiltinProviderRuntime({
    env: { XDG_DATA_HOME: '/data' },
    home: '/home',
    readFile: async () =>
      JSON.stringify(Object.fromEntries(Object.entries(keys).map(([id, key]) => [id, { key }]))),
  });
}

function codeBuddyRuntime(domain?: string) {
  return createBuiltinProviderRuntime({
    home: '/native-home',
    env: {},
    realpath: async (path) => path,
    codeBuddyProductPath: '/client/product.json',
    readFile: async (path) => path === '/client/product.json'
      ? JSON.stringify({ authentication: { attributes: { iOADomain: ['ioa.test'], externalDomain: ['external.test'] } } })
      : JSON.stringify({ auth: { accessToken: 'cb-token', ...(domain ? { domain } : {}) } }),
  });
}

test('three free-pool providers are registered with forge-managed credentials and exact models', () => {
  const catalog = createBuiltinCatalog();
  const zen = catalog.provider('opencode-zen');
  const openrouter = catalog.provider('openrouter');
  const go = catalog.provider('opencode-go');
  assert.ok(zen, 'opencode-zen must exist');
  assert.ok(openrouter, 'openrouter must exist');
  assert.ok(go, 'opencode-go must exist');
  assert.equal(zen!.credentialResolver, 'forge-managed');
  assert.equal(openrouter!.credentialResolver, 'forge-managed');
  assert.equal(go!.credentialResolver, 'forge-managed');
  assert.equal(zen!.protocols?.[0].endpoint, 'https://opencode.ai/zen/v1/chat/completions');
  assert.equal(openrouter!.protocols?.[0].endpoint, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(go!.protocols?.[0].endpoint, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.deepEqual(zen!.models.map((m) => m.id), ['mimo-v2.5-free', 'ling-3.0-flash-fin-free']);
  assert.deepEqual(openrouter!.models.map((m) => m.id), ['nex-agi/nex-n2.5-mini:free', 'cohere/north-mini-code:free']);
  assert.deepEqual(go!.models.map((m) => m.id), ['glm-5.3-flash', 'glm-5.3', 'deepseek-flash', 'hy3']);
  assert.equal(zen!.defaultModel, 'ling-3.0-flash-fin-free');
  assert.equal(openrouter!.defaultModel, 'nex-agi/nex-n2.5-mini:free');
  assert.equal(go!.defaultModel, 'glm-5.3-flash');
  // Pre-existing native OpenCode route is untouched.
  assert.ok(catalog.provider('opencode-native'), 'opencode-native must remain registered');
});

test('free-pool providers carry no retired DeepSeek v4/pro ids', () => {
  const catalog = createBuiltinCatalog();
  for (const provider of ['opencode-zen', 'openrouter', 'opencode-go']) {
    const ids = catalog.provider(provider)!.models.map((m) => m.id);
    for (const retired of [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash-202605',
      'deepseek-v4-pro-202606',
    ]) {
      assert.ok(!ids.includes(retired), `${provider} must not expose ${retired}`);
    }
  }
});

test('Zen and OpenRouter free models have exactly zero reference prices; Go models are nonzero', () => {
  const catalog = createBuiltinCatalog();
  const assertZero = (provider: string, modelId: string): void => {
    const model = catalog.provider(provider)!.models.find((entry) => entry.id === modelId)!;
    assert.equal(model.pricing?.inputUsdPerMillion, 0);
    assert.equal(model.pricing?.cachedInputUsdPerMillion, 0);
    assert.equal(model.pricing?.outputUsdPerMillion, 0);
    assert.ok(model.intelligence, `${provider}/${modelId} must still carry a configured tier`);
  };
  assertZero('opencode-zen', 'mimo-v2.5-free');
  assertZero('opencode-zen', 'ling-3.0-flash-fin-free');
  assertZero('openrouter', 'nex-agi/nex-n2.5-mini:free');
  assertZero('openrouter', 'cohere/north-mini-code:free');

  const go = catalog.provider('opencode-go')!;
  const prices = Object.fromEntries(go.models.map((entry) => [entry.id, entry.pricing!]));
  assert.equal(prices['glm-5.3-flash'].inputUsdPerMillion, 0.15);
  assert.equal(prices['glm-5.3-flash'].outputUsdPerMillion, 0.50);
  assert.equal(prices['glm-5.3'].inputUsdPerMillion, 1.4);
  assert.equal(prices['glm-5.3'].outputUsdPerMillion, 4.4);
  assert.equal(prices['deepseek-flash'].inputUsdPerMillion, 0.3);
  assert.equal(prices['deepseek-flash'].outputUsdPerMillion, 1.2);
  assert.equal(prices['hy3'].inputUsdPerMillion, 0.14);
  assert.equal(prices['hy3'].outputUsdPerMillion, 0.58);
  for (const id of Object.keys(prices)) {
    assert.ok(
      (prices[id].inputUsdPerMillion > 0 || prices[id].outputUsdPerMillion > 0) && prices[id].source === 'https://opencode.ai/docs/go/',
      `${id} Go price must be nonzero and sourced from the official Go docs`,
    );
  }
});

test('free supply is granted only to the exact authenticated allowlists for Zen and OpenRouter', async () => {
  const catalog = createBuiltinCatalog();
  const runtime = forgeManagedRuntime({
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
  assert.equal(zenFact!.source, 'opencode.zen.official');
  assert.equal(zenFact!.ruleId, 'opencode-zen.free_model_confirmed_free');
  const zenFact2 = runtime.freeSupply?.(zen, 'ling-3.0-flash-fin-free', zenCred!);
  assert.ok(zenFact2 && zenFact2.confirmedFree && zenFact2.ruleId === 'opencode-zen.free_model_confirmed_free');

  const orFact = runtime.freeSupply?.(or, 'nex-agi/nex-n2.5-mini:free', orCred!);
  assert.ok(orFact && orFact.confirmedFree);
  assert.equal(orFact!.source, 'openrouter.official');
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
  const runtime = forgeManagedRuntime({});
  // Anonymous (empty) credential.
  assert.equal(runtime.freeSupply?.(zen, 'mimo-v2.5-free', { value: '' }), undefined);
  // Missing credential object.
  assert.equal(runtime.freeSupply?.(zen, 'mimo-v2.5-free', undefined as never), undefined);
  // A non-managed provider never grants the free-pool models.
  const cb = catalog.provider('codebuddy')!;
  assert.equal(runtime.freeSupply?.(cb, 'mimo-v2.5-free', { value: 'x' }), undefined);
});

test('CodeBuddy HY free behavior is unaffected by the new free-pool logic', async () => {
  const catalog = createBuiltinCatalog();
  const cb = catalog.provider('codebuddy')!;
  const ioaRuntime = codeBuddyRuntime('ioa.test');
  const ioaCred = await ioaRuntime.credential(cb);
  assert.ok(ioaCred);
  const fact = ioaRuntime.freeSupply?.(cb, 'hy3', ioaCred!);
  assert.ok(fact && fact.confirmedFree);
  assert.equal(fact!.source, 'codebuddy.credential_environment');
  assert.equal(fact!.ruleId, 'codebuddy.verified_hy_model_confirmed_free');
  // Non-iOA environment still not free.
  const externalRuntime = codeBuddyRuntime('external.test');
  const extCred = await externalRuntime.credential(cb);
  assert.equal(externalRuntime.freeSupply?.(cb, 'hy3', extCred!), undefined);
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
