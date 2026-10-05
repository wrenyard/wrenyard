import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalizeObservedProviderModelId,
  createBuiltinCatalog,
  createBuiltinProviderRuntime,
  deriveTaskDispatchPlans,
  resolveRuntimeTaskPlans,
  upstreamAuthHeaders,
} from '../src/index.ts';

test('DeepSeek resolves the managed auth.json API entry and never leaks it into catalog data', async () => {
  const requestedPaths: string[] = [];
  const runtime = createBuiltinProviderRuntime({
    env: { XDG_CONFIG_HOME: '/config' }, home: '/home',
    readFile: async (path) => {
      requestedPaths.push(path);
      return JSON.stringify({ deepseek: { type: 'api', key: 'managed-deepseek-key' } });
    },
  });
  const provider = createBuiltinCatalog().provider('deepseek')!;
  const credential = await runtime.credential(provider);
  assert.equal(credential?.value, 'managed-deepseek-key');
  assert.equal(upstreamAuthHeaders(provider, credential!, 'openai_chat').get('authorization'), 'Bearer managed-deepseek-key');
  // The credential store path is the only file read; nothing is written.
  assert.deepEqual(requestedPaths, ['/config/wrenyard/providers/auth.json']);
});

test('DeepSeek falls back to an environment key only when the managed store has no entry', async () => {
  const runtime = createBuiltinProviderRuntime({
    env: { XDG_CONFIG_HOME: '/config', WRENYARD_DEEPSEEK_API_KEY: 'env-managed-key', DEEPSEEK_API_KEY: 'env-upstream-key' },
    home: '/home',
    readFile: async () => JSON.stringify({}),
  });
  const provider = createBuiltinCatalog().provider('deepseek')!;
  assert.deepEqual(await runtime.credential(provider), { value: 'env-managed-key' });
});

test('DeepSeek managed key wins over an environment key for the same provider', async () => {
  const runtime = createBuiltinProviderRuntime({
    env: { XDG_DATA_HOME: '/data', DEEPSEEK_API_KEY: 'env-legacy-key' },
    home: '/home',
    readFile: async () => JSON.stringify({ deepseek: { type: 'api', key: 'managed-wins' } }),
  });
  const provider = createBuiltinCatalog().provider('deepseek')!;
  assert.deepEqual(await runtime.credential(provider), { value: 'managed-wins' });
});

test('DeepSeek is unconfigured with neither managed nor environment credential', async () => {
  const runtime = createBuiltinProviderRuntime({
    env: { XDG_DATA_HOME: '/data' },
    home: '/home',
    readFile: async () => JSON.stringify({}),
  });
  const provider = createBuiltinCatalog().provider('deepseek')!;
  assert.equal(await runtime.credential(provider), undefined);
});

test('DeepSeek ignores a non-api managed entry and a missing credential store', async () => {
  const oauthRuntime = createBuiltinProviderRuntime({
    env: { XDG_DATA_HOME: '/data' }, home: '/home',
    readFile: async () => JSON.stringify({ deepseek: { type: 'oauth', refresh: 'r', access: 'a' } }),
  });
  const provider = createBuiltinCatalog().provider('deepseek')!;
  assert.equal(await oauthRuntime.credential(provider), undefined);

  const missingRuntime = createBuiltinProviderRuntime({
    env: { XDG_DATA_HOME: '/data' }, home: '/home',
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  assert.equal(await missingRuntime.credential(provider), undefined);
});

test('Kimi Coding maps the canonical kimi-k2.8 identity to the official kimi-for-coding wire id', async () => {
  const catalog = createBuiltinCatalog();
  const provider = catalog.provider('kimi-coding')!;

  // The translation is credential-independent: it holds with no credential,
  // with an arbitrary credential, and for every gateway plan.
  const runtime = createBuiltinProviderRuntime({ readFile: async () => '' });
  assert.equal(runtime.resolveUpstreamModel(provider, 'kimi-k2.8', undefined), 'kimi-for-coding');
  assert.equal(runtime.resolveUpstreamModel(provider, 'kimi-k2.8', { value: 'any-kimi-key' }), 'kimi-for-coding');
  // Every other Kimi model keeps its logical id; nothing else remaps.
  for (const model of ['k3', 'kimi-k3']) {
    assert.equal(runtime.resolveUpstreamModel(provider, model, undefined), model);
  }
  // CodeBuddy behavior is unchanged: without a credential nothing remaps.
  const codebuddy = catalog.provider('codebuddy')!;
  assert.equal(runtime.resolveUpstreamModel(codebuddy, 'hy3', undefined), 'hy3');

  // The upstream wire alias normalizes back to the public canonical model.
  assert.equal(
    runtime.publicResponseModel(provider, 'kimi-for-coding', 'kimi-for-coding', 'kimi-coding/kimi-k2.8'),
    'kimi-coding/kimi-k2.8',
  );
  assert.equal(
    runtime.publicResponseModel(provider, 'kimi-k2.8', 'kimi-for-coding', 'kimi-coding/kimi-k2.8'),
    'kimi-coding/kimi-k2.8',
  );
  assert.equal(
    runtime.publicResponseModel(provider, 'provider-changed-model', 'kimi-for-coding', 'kimi-coding/kimi-k2.8'),
    'provider-changed-model',
  );

  // A gateway dispatch plan keeps the public model and carries the wire alias.
  const plans = await resolveRuntimeTaskPlans(catalog, runtime);
  assert.equal(plans['kimi-coding/kimi-k2.8:cc']?.model, 'kimi-k2.8');
  assert.equal(plans['kimi-coding/kimi-k2.8:cc']?.upstreamModel, 'kimi-for-coding');
  // K3 has no wire remap, so no upstreamModel is materialized.
  assert.equal(plans['kimi-coding/k3:cc']?.model, 'k3');
  assert.equal(plans['kimi-coding/k3:cc']?.upstreamModel, undefined);
});

test('runtime task plans honor an explicit thinking-mapped upstream model over the provider remap', async () => {
  const catalog = createBuiltinCatalog();
  // A native Cursor run has no provider-level remap; the thinking mapping's
  // own upstream substitution must survive compilation.
  const runtime = createBuiltinProviderRuntime({ readFile: async () => '' });
  const plans = await resolveRuntimeTaskPlans(catalog, runtime);
  assert.equal(plans['cursor/gpt-5.6-sol:cur']?.model, 'gpt-5.6-sol');
  assert.equal(plans['cursor/gpt-5.6-sol:cur']?.upstreamModel, 'gpt-5.6-sol[context=272k,reasoning=max,fast=false]');
});

test('canonicalizeObservedProviderModelId reverses the Kimi Coding wire alias from the registry SSOT', () => {
  // The official Kimi Coding route only emits the wire id `kimi-for-coding`;
  // it must be attributed back to the registered canonical model.
  assert.equal(canonicalizeObservedProviderModelId('kimi-coding', 'kimi-for-coding'), 'kimi-k2.8');
  // Every other Kimi identity is already canonical or unknown, and unknown is
  // never rewritten.
  for (const model of ['kimi-k2.8', 'k3', 'kimi-k3', 'kimi-for-coding-preview', '']) {
    assert.equal(canonicalizeObservedProviderModelId('kimi-coding', model), model);
  }
  // The mapping is provider-scoped: another provider's identical string stays.
  assert.equal(canonicalizeObservedProviderModelId('codebuddy', 'kimi-for-coding'), 'kimi-for-coding');
  assert.equal(canonicalizeObservedProviderModelId('moonshot', 'kimi-for-coding'), 'kimi-for-coding');
});

test('canonicalizeObservedProviderModelId reverses the Cursor Grok thinking wire alias to its registered model', () => {
  // Cursor confirms Grok only at high, materialized as the suffixed wire id.
  assert.equal(canonicalizeObservedProviderModelId('cursor', 'cursor-grok-4.6-high'), 'grok-4.6');
  assert.equal(canonicalizeObservedProviderModelId('cursor', 'grok-4.7-high'), 'grok-4.7');
  // The canonical id and any unknown/legacy Cursor id are left unchanged.
  for (const model of ['grok-4.6', 'grok-4.7', 'cursor-grok-4.6-low', 'grok-4.5', 'grok-4.7-high-fast', 'composer-2.5', 'cursor-composer-2.5']) {
    assert.equal(canonicalizeObservedProviderModelId('cursor', model), model);
  }
  // Ambiguity is never guessed: the grok wire alias belongs to cursor, not to
  // the spacex-ai provider.
  assert.equal(canonicalizeObservedProviderModelId('spacex-ai', 'cursor-grok-4.6-high'), 'cursor-grok-4.6-high');
  assert.equal(canonicalizeObservedProviderModelId('anthropic', 'cursor-grok-4.6-high'), 'cursor-grok-4.6-high');
});

test('credential store keeps an existing anthropic API key and never promotes a subscription oauth entry', async () => {
  const preserved: Record<string, { type?: string; key?: string }> = {
    anthropic: { type: 'api', key: 'existing-api-key' },
    'anthropic-api': { type: 'api', key: 'stale-api-key' },
  };
  const preservedRuntime = createBuiltinProviderRuntime({
    home: '/native-home',
    readFile: async () => JSON.stringify(preserved),
  });
  const provider = createBuiltinCatalog().provider('anthropic')!;
  assert.deepEqual(await preservedRuntime.credential(provider), { value: 'existing-api-key' });

  const oauthOnly = createBuiltinProviderRuntime({
    home: '/native-home',
    readFile: async () => JSON.stringify({ 'anthropic-api': { type: 'oauth', key: 'subscription-token' } }),
  });
  assert.equal(await oauthOnly.credential(provider), undefined);
});
