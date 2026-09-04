import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltinCatalog, createBuiltinProviderRuntime, upstreamAuthHeaders } from '../src/index.ts';

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
  let requestedPath = '';
  const runtime = createBuiltinProviderRuntime({
    home: '/native-home',
    readFile: async (path) => {
      requestedPath = path;
      return JSON.stringify({ auth: { accessToken: 'native-codebuddy-token' } });
    },
  });
  const provider = createBuiltinCatalog().provider('codebuddy')!;

  assert.deepEqual(await runtime.credential(provider), { value: 'native-codebuddy-token' });
  assert.match(requestedPath, /CodeBuddyExtension.*Tencent-Cloud\.coding-copilot\.info/u);
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
