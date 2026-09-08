import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltinCatalog,
  createBuiltinProviderRuntime,
  deriveTaskDispatchPlans,
  resolveRuntimeTaskPlans,
  upstreamAuthHeaders,
} from '../src/index.ts';

const codeBuddyAttributes = {
  internalDomain: ['internal.test', '*.shared.test'],
  iOADomain: ['ioa.test', 'tenant.*.test', 'team.shared.test'],
  cloudHostedDomain: ['*.cloud.test'],
  externalDomain: ['external.test'],
};

function codeBuddyRuntime(domain?: string, attributes: unknown = codeBuddyAttributes) {
  return createBuiltinProviderRuntime({
    home: '/native-home',
    codeBuddyProductPath: '/client/product.json',
    readFile: async (path) => {
      if (path === '/client/product.json') {
        return JSON.stringify({ authentication: { attributes } });
      }
      return JSON.stringify({ auth: { accessToken: 'native-codebuddy-token', ...(domain ? { domain } : {}) } });
    },
  });
}

test('forge-managed credentials are read without being projected into catalog data', async () => {
  const runtime = createBuiltinProviderRuntime({
    env: { XDG_DATA_HOME: '/data' }, home: '/home',
    readFile: async () => JSON.stringify({ openai: { key: 'secret' } }),
  });
  const provider = createBuiltinCatalog().provider('openai')!;
  const credential = await runtime.credential(provider);
  assert.equal(credential?.value, 'secret');
  assert.equal(upstreamAuthHeaders(provider, credential!, 'openai_chat').get('authorization'), 'Bearer secret');
});

test('CodeBuddy reuses the native nested access token without a managed credential store', async () => {
  const requestedPaths: string[] = [];
  const runtime = createBuiltinProviderRuntime({
    home: '/native-home',
    readFile: async (path) => {
      requestedPaths.push(path);
      return JSON.stringify({ auth: { accessToken: 'native-codebuddy-token' } });
    },
  });
  const provider = createBuiltinCatalog().provider('codebuddy')!;

  assert.deepEqual(await runtime.credential(provider), { value: 'native-codebuddy-token' });
  assert.ok(requestedPaths.some((path) => /CodeBuddyExtension.*Tencent-Cloud\.coding-copilot\.info/u.test(path)));
  assert.equal(
    upstreamAuthHeaders(provider, { value: 'native-codebuddy-token' }, 'openai_chat').get('authorization'),
    'Bearer native-codebuddy-token',
  );
  await assert.rejects(() => runtime.configureApiKey(provider, 'replacement'), /does not accept a managed API key/u);
});

test('CodeBuddy keeps the legacy flat native token shape as a read-only fallback', async () => {
  const runtime = createBuiltinProviderRuntime({
    home: '/native-home',
    readFile: async () => JSON.stringify({ 'auth.accessToken': 'flat-codebuddy-token' }),
  });
  const provider = createBuiltinCatalog().provider('codebuddy')!;

  assert.deepEqual(await runtime.credential(provider), { value: 'flat-codebuddy-token' });
});

test('CodeBuddy iOA routing uses the bundled domain matcher and only the five confirmed upstream ids', async () => {
  const runtime = codeBuddyRuntime('tenant.alpha.test');
  const provider = createBuiltinCatalog().provider('codebuddy')!;
  const credential = await runtime.credential(provider);
  assert.ok(credential);

  assert.deepEqual(Object.fromEntries([
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'hy4-preview',
    'hy3',
    'minimax-m3',
  ].map((model) => [model, runtime.resolveUpstreamModel(provider, model, credential)])), {
    'deepseek-v4-flash': 'deepseek-v4-flash-ioa',
    'deepseek-v4-pro': 'deepseek-v4-pro-ioa',
    'hy4-preview': 'hy4-preview-ioa',
    'hy3': 'hy3-ioa',
    'minimax-m3': 'minimax-m3-ioa',
  });
  for (const model of ['kimi-k3', 'glm-5.3', 'glm-5.3-flash']) {
    assert.equal(runtime.resolveUpstreamModel(provider, model, credential), model);
  }
  assert.equal(
    runtime.publicResponseModel(provider, 'hy4-preview-ioa', 'hy4-preview-ioa', 'codebuddy/hy4-preview'),
    'codebuddy/hy4-preview',
  );
  assert.equal(
    runtime.publicResponseModel(provider, 'hy4-preview', 'hy4-preview-ioa', 'codebuddy/hy4-preview'),
    'codebuddy/hy4-preview',
  );
  assert.equal(
    runtime.publicResponseModel(provider, 'hy3', 'hy3-ioa', 'codebuddy/hy3'),
    'codebuddy/hy3',
  );
  assert.equal(
    runtime.publicResponseModel(provider, 'provider-changed-model', 'hy4-preview-ioa', 'codebuddy/hy4-preview'),
    'provider-changed-model',
  );
});

test('CodeBuddy non-iOA, unknown, missing configuration, and official priority keep logical ids', async () => {
  const provider = createBuiltinCatalog().provider('codebuddy')!;
  for (const runtime of [
    codeBuddyRuntime('external.test'),
    codeBuddyRuntime('unknown.test'),
    codeBuddyRuntime(),
    codeBuddyRuntime('team.shared.test'),
    codeBuddyRuntime('ioa.test', null),
  ]) {
    const credential = await runtime.credential(provider);
    assert.ok(credential);
    assert.equal(runtime.resolveUpstreamModel(provider, 'hy4-preview', credential), 'hy4-preview');
    assert.equal(runtime.resolveUpstreamModel(provider, 'hy3', credential), 'hy3');
  }
});

test('runtime task plans compile canonical targets and keep CodeBuddy iOA remap runtime-owned', async () => {
  const catalog = createBuiltinCatalog();
  const runtime = codeBuddyRuntime('ioa.test');
  // Logical plan identity stays canonical (public names) before any runtime remap.
  const logical = deriveTaskDispatchPlans(catalog);
  assert.equal(logical['codebuddy/hy4-preview:cb']?.model, 'hy4-preview');
  assert.equal(logical['codebuddy/hy3:cb']?.model, 'hy3');
  assert.equal(logical['codebuddy/deepseek-v4-pro:cb']?.model, 'deepseek-v4-pro');
  assert.equal(logical['codebuddy/deepseek-v4-flash:cb']?.model, 'deepseek-v4-flash');
  assert.equal(logical['codebuddy/minimax-m3:cb']?.model, 'minimax-m3');
  assert.equal(logical['codebuddy/kimi-k3:cb']?.model, 'kimi-k3');
  assert.equal(logical['codebuddy/glm-5.3:cb']?.model, 'glm-5.3');
  assert.equal(logical['codebuddy/glm-5.3-flash:cb']?.model, 'glm-5.3-flash');

  const plans = await resolveRuntimeTaskPlans(catalog, runtime);
  assert.equal(plans['codebuddy/hy4-preview:cb']?.model, 'hy4-preview-ioa');
  assert.equal(plans['codebuddy/hy3:cb']?.model, 'hy3-ioa');
  assert.equal(plans['codebuddy/deepseek-v4-pro:cb']?.model, 'deepseek-v4-pro-ioa');
  assert.equal(plans['codebuddy/deepseek-v4-flash:cb']?.model, 'deepseek-v4-flash-ioa');
  assert.equal(plans['codebuddy/minimax-m3:cb']?.model, 'minimax-m3-ioa');
  assert.equal(plans['codebuddy/kimi-k3:cb']?.model, 'kimi-k3');
  assert.equal(plans['codebuddy/glm-5.3:cb']?.model, 'glm-5.3');
  assert.equal(plans['codebuddy/glm-5.3-flash:cb']?.model, 'glm-5.3-flash');
  // Canonical target keys are preserved through the runtime remap.
  assert.deepEqual(Object.keys(plans), Object.keys(logical));
  // The private iOA suffix never leaks into public plan keys.
  assert.ok(!Object.keys(logical).some((key) => key.includes('hy3-ioa')));
  assert.ok(!Object.keys(plans).some((key) => key.includes('hy3-ioa')));
});

test('CodeBuddy internal/ioa credentials emit a confirmed-free supply fact scoped to that exact credential', async () => {
  const provider = createBuiltinCatalog().provider('codebuddy')!;
  for (const domain of ['internal.test', '*.shared.test'.replace('*', 'api'), 'ioa.test', 'tenant.alpha.test']) {
    const runtime = codeBuddyRuntime(domain);
    const credential = await runtime.credential(provider);
    assert.ok(credential, `expected a credential for ${domain}`);
    const fact = runtime.freeSupply?.(provider, credential!);
    assert.ok(fact, `expected a confirmed-free fact for ${domain}`);
    assert.equal(fact!.confirmedFree, true);
    assert.equal(fact!.source, 'codebuddy.credential_environment');
    assert.equal(fact!.ruleId, 'codebuddy.internal_or_ioa_confirmed_free');
    // Privacy-safe: no token, no account/environment domain, no upstream suffix.
    const serialized = JSON.stringify(fact);
    assert.ok(!serialized.includes('native-codebuddy-token'), 'fact must not expose the token');
    assert.ok(!serialized.includes(domain.replace('*', '')), 'fact must not expose the domain');
    assert.ok(!serialized.includes('-ioa'), 'fact must not expose the private iOA upstream suffix');
  }
});

test('CodeBuddy external/cloudhosted/unknown/missing and other providers never confirm free', async () => {
  const provider = createBuiltinCatalog().provider('codebuddy')!;
  const scenarios: Array<[string, ReturnType<typeof codeBuddyRuntime>]> = [
    ['external', codeBuddyRuntime('external.test')],
    ['cloudhosted', codeBuddyRuntime('prod.cloud.test')],
    ['unknown domain', codeBuddyRuntime('unknown.test')],
    ['missing attributes', codeBuddyRuntime('internal.test', null)],
    ['missing domain', codeBuddyRuntime()],
  ];
  for (const [name, runtime] of scenarios) {
    const credential = await runtime.credential(provider);
    assert.ok(credential, name);
    assert.equal(runtime.freeSupply?.(provider, credential!), undefined, name);
  }

  // The classification is tied to the loaded credential object: an internal
  // credential read by one runtime is not free on a runtime whose credential
  // loaded under an external environment.
  const internalRuntime = codeBuddyRuntime('internal.test');
  const internalCredential = await internalRuntime.credential(provider);
  assert.ok(internalCredential);
  const externalRuntime = codeBuddyRuntime('external.test');
  const externalCredential = await externalRuntime.credential(provider);
  assert.ok(externalCredential);
  assert.equal(externalRuntime.freeSupply?.(provider, internalCredential!), undefined);
  assert.equal(internalRuntime.freeSupply?.(provider, externalCredential!), undefined);

  // Missing credential: no registered classification -> undefined.
  assert.equal(internalRuntime.freeSupply?.(provider, { value: 'never-loaded-token' }), undefined);

  // Every other provider returns undefined regardless of the credential.
  const openaiProvider = createBuiltinCatalog().provider('openai')!;
  assert.equal(internalRuntime.freeSupply?.(openaiProvider, internalCredential!), undefined);
});
