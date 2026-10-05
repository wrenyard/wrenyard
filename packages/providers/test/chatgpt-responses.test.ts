import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltinCatalog,
  createBuiltinProviderRuntime,
  upstreamAuthHeaders,
  type ChatGptGatewayAuthAdapter,
  type ProviderDefinition,
} from '../src/index.ts';
import { bindChatGptGatewayCredential, chatGptGatewayAccountId } from '../src/chatgpt/runtime.ts';

const CHATGPT_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

function gatewayAdapter(
  credential: { accessToken: string; accountId: string } = { accessToken: 'gateway-token', accountId: 'acct-1' },
): ChatGptGatewayAuthAdapter {
  return {
    read: async () => credential,
    refresh: async () => credential,
  };
}

/** A runtime whose managed credential store is empty, so only chatgpt resolves. */
function runtimeWith(adapter?: ChatGptGatewayAuthAdapter) {
  return createBuiltinProviderRuntime({
    ...(adapter ? { codexGatewayAuth: adapter } : {}),
    readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
}

test('chatgpt declares only the openai_responses protocol with the Codex subscription endpoint', () => {
  const provider = createBuiltinCatalog().provider('chatgpt')!;
  assert.deepEqual(provider.protocols, [
    { protocol: 'openai_responses', endpoint: CHATGPT_ENDPOINT, authScheme: 'bearer' },
  ]);
  // Existing codex-native identity is untouched.
  assert.equal(provider.credentialResolver, 'codex');
  assert.deepEqual(provider.nativeClients, ['codex']);
  assert.deepEqual(provider.models.map((model) => model.id), ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']);
});

test('chatgpt appears only in the Responses model directory, never in Chat', () => {
  const catalog = createBuiltinCatalog();
  const available = (provider: ProviderDefinition) => provider.id === 'chatgpt';
  const responses = catalog.listGatewayModels('openai_responses', available);
  assert.ok(responses.some((model) => model.publicId === 'chatgpt/gpt-6.1-sol'));
  const chat = catalog.listGatewayModels('openai_chat', available);
  assert.equal(chat.filter((model) => model.provider === 'chatgpt').length, 0);
  // The catalog's existing error is explicit that the protocol is unsupported.
  assert.throws(
    () => catalog.resolveGatewayModel('openai_chat', 'chatgpt/gpt-6.1-sol'),
    /does not support openai_chat/u,
  );
});

test('an injected reader resolves a bound chatgpt credential and native headers', async () => {
  const provider = createBuiltinCatalog().provider('chatgpt')!;
  const runtime = runtimeWith(gatewayAdapter());
  const credential = await runtime.credential(provider);
  assert.deepEqual(credential, { value: 'gateway-token' });
  assert.equal(chatGptGatewayAccountId(credential!), 'acct-1');

  const headers = upstreamAuthHeaders(provider, credential!, 'openai_responses');
  assert.equal(headers.get('authorization'), 'Bearer gateway-token');
  assert.equal(headers.get('chatgpt-account-id'), 'acct-1');
  assert.equal(headers.get('originator'), 'codex-tui');
  assert.equal(headers.get('accept'), 'text/event-stream');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('user-agent'), 'codex-tui/0.154.0');
  assert.match(headers.get('session_id')!, /^[0-9a-f-]{36}$/u);
  // Every call is a fresh session; the account/token pair stays stable.
  const next = upstreamAuthHeaders(provider, credential!, 'openai_responses');
  assert.notEqual(next.get('session_id'), headers.get('session_id'));
  assert.equal(next.get('chatgpt-account-id'), 'acct-1');

  // Model identity is unchanged: no wire remap for chatgpt.
  assert.equal(runtime.resolveUpstreamModel(provider, 'gpt-6.1-sol', credential), 'gpt-6.1-sol');
  assert.equal(runtime.publicResponseModel(provider, 'gpt-6.1-sol', 'gpt-6.1-sol', 'chatgpt/gpt-6.1-sol'), 'chatgpt/gpt-6.1-sol');
});

test('chatgpt account headers never leak to other providers or unbound credentials', async () => {
  const catalog = createBuiltinCatalog();
  const chatgpt = catalog.provider('chatgpt')!;
  const openai = catalog.provider('openai')!;
  const runtime = runtimeWith(gatewayAdapter());
  const credential = (await runtime.credential(chatgpt))!;

  const headers = upstreamAuthHeaders(openai, credential, 'openai_responses');
  assert.equal(headers.get('chatgpt-account-id'), null);
  assert.equal(headers.get('originator'), null);
  assert.equal(headers.get('session_id'), null);

  // The same chatgpt provider with an unbound credential carries no account identity.
  const unbound = upstreamAuthHeaders(chatgpt, { value: 'gateway-token' }, 'openai_responses');
  assert.equal(unbound.get('chatgpt-account-id'), null);
  assert.equal(unbound.get('originator'), null);

  // An explicitly bound foreign credential does not help another provider.
  const foreign = { value: 'foreign' };
  bindChatGptGatewayCredential(foreign, 'foreign-acct');
  assert.equal(upstreamAuthHeaders(openai, foreign, 'openai_responses').get('chatgpt-account-id'), null);
});

test('refreshCredential reuses the injected client refresh and rebinds the account', async () => {
  const provider = createBuiltinCatalog().provider('chatgpt')!;
  const seen: Array<{ accessToken: string; accountId: string }> = [];
  const adapter: ChatGptGatewayAuthAdapter = {
    read: async () => ({ accessToken: 'token-a', accountId: 'acct-a' }),
    refresh: async (credential, signal) => {
      assert.ok(signal instanceof AbortSignal);
      seen.push(credential);
      return { accessToken: 'token-b', accountId: 'acct-b' };
    },
  };
  const runtime = runtimeWith(adapter);
  const credential = (await runtime.credential(provider))!;
  const refreshed = await runtime.refreshCredential!(provider, credential, new AbortController().signal);
  assert.deepEqual(seen, [{ accessToken: 'token-a', accountId: 'acct-a' }]);
  assert.deepEqual(refreshed, { value: 'token-b' });
  assert.equal(chatGptGatewayAccountId(refreshed), 'acct-b');
  assert.equal(upstreamAuthHeaders(provider, refreshed, 'openai_responses').get('authorization'), 'Bearer token-b');
  // The original credential is untouched.
  assert.equal(upstreamAuthHeaders(provider, credential, 'openai_responses').get('chatgpt-account-id'), 'acct-a');

  // Only the exact chatgpt/codex path is refreshable, and only a bound credential.
  const openai = createBuiltinCatalog().provider('openai')!;
  await assert.rejects(
    () => runtime.refreshCredential!(openai, credential, new AbortController().signal),
    /does not support credential refresh/u,
  );
  await assert.rejects(
    () => runtime.refreshCredential!(provider, { value: 'unbound' }, new AbortController().signal),
    /not refreshable/u,
  );
});

test('a missing adapter leaves chatgpt unavailable without disturbing other providers', async () => {
  const catalog = createBuiltinCatalog();
  const chatgpt = catalog.provider('chatgpt')!;
  const openai = catalog.provider('openai')!;

  const runtime = createBuiltinProviderRuntime({
    env: { XDG_CONFIG_HOME: '/config' },
    home: '/home',
    readFile: async () => JSON.stringify({ openai: { type: 'api', key: 'managed-openai' } }),
  });
  assert.equal(await runtime.credential(chatgpt), undefined);
  assert.deepEqual(await runtime.credential(openai), { value: 'managed-openai' });

  // A different provider sharing the codex resolver name is never served by this path.
  const foreign = { id: 'mystery', credentialResolver: 'codex', models: [] } as unknown as ProviderDefinition;
  assert.equal(await runtime.credential(foreign), undefined);
});

test('an unavailable or malformed injected reader leaves chatgpt unavailable', async () => {
  const provider = createBuiltinCatalog().provider('chatgpt')!;

  // A rejecting reader is unavailable, not a thrown error.
  const rejected = runtimeWith({
    read: async () => { throw new Error('Codex auth.json is invalid'); },
    refresh: async (credential) => credential,
  });
  assert.equal(await rejected.credential(provider), undefined);

  // A reader that returns empty or non-string fields is likewise unavailable.
  const malformed: unknown[] = [
    {},
    { accessToken: '', accountId: 'acct-1' },
    { accessToken: 'gateway-token', accountId: '' },
    { accessToken: 42, accountId: 'acct-1' },
    { accessToken: 'gateway-token', accountId: null },
  ];
  for (const value of malformed) {
    const runtime = runtimeWith({
      read: async () => value as { accessToken: string; accountId: string },
      refresh: async (credential) => credential,
    });
    assert.equal(await runtime.credential(provider), undefined, `unavailable for ${JSON.stringify(value)}`);
  }
});
