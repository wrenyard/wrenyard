import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltinCatalog,
  createBuiltinProviderRuntime,
  resolveBuiltinRuntimeDispatchPlans,
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

test('CodeBuddy iOA routing uses the bundled domain matcher and only the four confirmed upstream ids', async () => {
  const runtime = codeBuddyRuntime('tenant.alpha.test');
  const provider = createBuiltinCatalog().provider('codebuddy')!;
  const credential = await runtime.credential(provider);
  assert.ok(credential);

  assert.deepEqual(Object.fromEntries([
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'hy4-preview',
    'minimax-m3',
  ].map((model) => [model, runtime.resolveUpstreamModel(provider, model, credential)])), {
    'deepseek-v4-flash': 'deepseek-v4-flash-ioa',
    'deepseek-v4-pro': 'deepseek-v4-pro-ioa',
    'hy4-preview': 'hy4-preview-ioa',
    'minimax-m3': 'minimax-m3-ioa',
  });
  for (const model of ['kimi-k3', 'glm-5.3', 'glm-5.3-flash']) {
    assert.equal(runtime.resolveUpstreamModel(provider, model, credential), model);
  }
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
  }
});

test('daemon native dispatch plans consume the same CodeBuddy upstream resolver', async () => {
  const catalog = createBuiltinCatalog();
  const runtime = codeBuddyRuntime('ioa.test');
  const plans = await resolveBuiltinRuntimeDispatchPlans(catalog, runtime);

  assert.equal(plans['cb-hy']?.model, 'hy4-preview-ioa');
  assert.equal(plans['cb-ds']?.model, 'deepseek-v4-pro-ioa');
  assert.equal(plans['cb-dsf']?.model, 'deepseek-v4-flash-ioa');
  assert.equal(plans['cb-minimax']?.model, 'minimax-m3-ioa');
  assert.equal(plans['cb-kimi']?.model, 'kimi-k3');
  assert.equal(plans['cb-glm']?.model, 'glm-5.3');
  assert.equal(plans['cb-glmf']?.model, 'glm-5.3-flash');
});
