import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { Catalog } from '@wrenyard/providers/catalog';
import { createBuiltinCatalog, createBuiltinProviderRuntime, type ChatGptGatewayAuthAdapter } from '@wrenyard/providers';
import { createModelGateway, type GatewayRequestCompletedEvent } from '../src/index.ts';

function fixture(
  fetchImpl: typeof fetch,
  onRequestCompleted?: Parameters<typeof createModelGateway>[0]['onRequestCompleted'],
  now?: () => number,
) {
  const catalog = new Catalog();
  catalog.registerProvider({
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'managed',
    models: [{
      id: 'public',
      displayName: 'Public',
      intelligence: 'mid',
      speed: 40,
      pricing: [1.5, 3, 15],
    }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://upstream.test/v1/chat/completions', authScheme: 'bearer' }],
  });
  return createModelGateway({
    catalog,
    fetch: fetchImpl,
    onRequestCompleted,
    now,
    providers: {
      credential: async () => ({ value: 'upstream-secret' }),
      resolveUpstreamModel: (_provider, model) => model === 'public' ? 'private' : model,
      publicResponseModel: (provider, model, upstreamModel, publicModel) => {
        const logicalModel = publicModel.slice(provider.id.length + 1);
        return model === upstreamModel || model === logicalModel ? publicModel : model;
      },
      configureApiKey: async () => undefined,
    },
  });
}

test('replaces only model and upstream auth, then streams the response', async (t) => {
  let seenBody: unknown;
  let seenAuth: string | null = null;
  const gateway = fixture(async (_url, init) => {
    seenBody = JSON.parse(String(init?.body));
    seenAuth = new Headers(init?.headers).get('authorization');
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('one')); controller.enqueue(new TextEncoder().encode('two')); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const server = createServer((request, response) => { void gateway.handle(request, response); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'vendor/public', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  assert.equal(await response.text(), 'onetwo');
  assert.deepEqual(seenBody, { model: 'private', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } });
  assert.equal(seenAuth, 'Bearer upstream-secret');
  server.close();
  await once(server, 'close');
});

test('normalizes an upstream JSON response model back to the public model id', async (t) => {
  const gateway = fixture(async () => new Response(JSON.stringify({
    id: 'chatcmpl-test',
    model: 'private',
    choices: [{ message: { role: 'assistant', content: 'private remains content' } }],
  }), { headers: { 'content-type': 'application/json' } }));
  const server = createServer((request, response) => { void gateway.handle(request, response); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'vendor/public', messages: [] }),
  });
  assert.deepEqual(await response.json(), {
    id: 'chatcmpl-test',
    model: 'vendor/public',
    choices: [{ message: { role: 'assistant', content: 'private remains content' } }],
  });
  server.close();
  await once(server, 'close');
});

test('normalizes split SSE model fields without changing event content or tool calls', async (t) => {
  const event = `data: ${JSON.stringify({
    id: 'chatcmpl-test',
    model: 'private',
    choices: [{ delta: { content: 'private', tool_calls: [{ function: { arguments: '{\"model\":\"private\"}' } }] } }],
  })}\n\ndata: [DONE]\n\n`;
  const midpoint = Math.floor(event.length / 2);
  const gateway = fixture(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(event.slice(0, midpoint)));
      controller.enqueue(new TextEncoder().encode(event.slice(midpoint)));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const server = createServer((request, response) => { void gateway.handle(request, response); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'vendor/public', messages: [], stream: true }),
  });
  const payload = await response.text();
  const data = JSON.parse(payload.split('\n')[0]!.slice('data: '.length)) as Record<string, unknown>;
  assert.equal(data.model, 'vendor/public');
  assert.equal(JSON.stringify(data).includes('"content":"private"'), true);
  assert.equal(JSON.stringify(data).includes('\\"model\\":\\"private\\"'), true);
  assert.match(payload, /data: \[DONE\]/u);
  server.close();
  await once(server, 'close');
});

test('scoped openai chat stream forwards the same endpoint, sets include_usage, and is attributed once', async (t) => {
  let seenUrl: string | undefined;
  let seenBody: Record<string, unknown> = {};
  const events: GatewayRequestCompletedEvent[] = [];
  const stream = 'data: {"id":"r1","model":"private","choices":[{"delta":{"content":"he"}}]}\n\n'
    + 'data: {"id":"r1","model":"private","choices":[{"delta":{"content":"llo"}}]}\n\n'
    + 'data: {"id":"r1","model":"private","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
    + 'data: {"id":"r1","model":"private","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":7,"total_tokens":8}}\n\n'
    + 'data: [DONE]\n\n';
  let sampleTime = 1000;
  const gateway = fixture(async (url, init) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body));
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }, (event) => { events.push(event); }, () => (sampleTime += 1000));
  const server = createServer((request, response) => { void gateway.handle(request, response); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/execution/exec_abc/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'vendor/public', messages: [], stream: true }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /"model":"vendor\/public"/u);
  // The execution segment is attribution-only and never reaches upstream.
  assert.equal(seenUrl, 'https://upstream.test/v1/chat/completions');
  assert.deepEqual(seenBody.stream_options, { include_usage: true });
  assert.equal(seenBody.stream, true);
  const completed = events.filter((event) => event.status === 200 && event.tps_samples !== undefined);
  assert.equal(completed.length, 1);
  assert.equal(completed[0]!.executionId, 'exec_abc');
  assert.equal(completed[0]!.tps_sampling_contract, 'tokenizer_v1');
  assert.deepEqual(completed[0]!.tps_samples, [{
    response_id: 'r1',
    model: 'vendor/public',
    // cl100k_base over the observed 'he' + 'llo' channel, not the reported 7.
    output_tokens: 1,
    first_token_at_ms: 2000,
    completed_at_ms: 3000,
  }]);
  assert.ok(!('requestBody' in completed[0]!) && !('prompt' in completed[0]!));
  server.close();
  await once(server, 'close');
});

test('a truncated stream emits no speed sample', async (t) => {
  const events: GatewayRequestCompletedEvent[] = [];
  // Truncated upstream body: two observed generation deltas, no finish_reason
  // and no [DONE]. It cannot claim a successfully completed sample.
  const stream = 'data: {"id":"r9","model":"private","choices":[{"delta":{"content":"he"}}]}\n\n'
    + 'data: {"id":"r9","model":"private","choices":[{"delta":{"content":"llo"}}]}\n\n';
  let sampleTime = 5000;
  const gateway = fixture(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), (event) => { events.push(event); }, () => (sampleTime += 1000));
  const server = createServer((request, response) => { void gateway.handle(request, response); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/execution/exec_cut/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'vendor/public', messages: [], stream: true }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.ok(events.every(event => event.tps_samples === undefined));
  server.close();
  await once(server, 'close');
});

test('an upstream error on a scoped path emits no sample', async (t) => {
  const events: GatewayRequestCompletedEvent[] = [];
  const gateway = fixture(async () => new Response('upstream rejected', { status: 503, headers: { 'content-type': 'text/plain' } }), (event) => { events.push(event); });
  const server = createServer((request, response) => { void gateway.handle(request, response); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/execution/exec_err/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'vendor/public', messages: [], stream: true }),
  });
  assert.equal(response.status, 503);
  assert.equal(events.every((event) => event.tps_samples === undefined), true);
  assert.equal(events.at(-1)!.executionId, 'exec_err');
  server.close();
  await once(server, 'close');
});

test('a malformed execution scope is not served and stays compatible unscoped', async (t) => {
  const gateway = fixture(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
  const server = createServer((request, response) => { void gateway.handle(request, response).then((handled) => { if (!handled) { response.writeHead(404); response.end(); } }); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const malformed = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/execution/bad%2Fid/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'vendor/public', messages: [] }),
  });
  assert.equal(malformed.status, 404);
  const unscoped = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'vendor/public', messages: [] }),
  });
  assert.equal(unscoped.status, 200);
  server.close();
  await once(server, 'close');
});

test('unscoped non-streaming requests are unchanged and carry no sample', async (t) => {
  const events: GatewayRequestCompletedEvent[] = [];
  let seenBody: Record<string, unknown> = {};
  const gateway = fixture(async (_url, init) => {
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: 'chatcmpl-test', model: 'private', choices: [] }), { headers: { 'content-type': 'application/json' } });
  }, (event) => { events.push(event); });
  const server = createServer((request, response) => { void gateway.handle(request, response); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'vendor/public', messages: [] }),
  });
  assert.equal('stream_options' in seenBody, false);
  assert.equal(events.at(-1)!.tps_samples, undefined);
  assert.equal(events.at(-1)!.executionId, undefined);
  server.close();
  await once(server, 'close');
});

test('/models only returns credential-available protocol models', async (t) => {
  const gateway = fixture(fetch);
  const connection = await gateway.connection('http://127.0.0.1:8787');
  assert.deepEqual(connection.models.map((entry) => entry.publicId), ['vendor/public']);
  assert.equal(connection.openaiChatBaseUrl, 'http://127.0.0.1:8787/gateway/openai-chat/v1');
});

test('an upstream failure is returned once without retrying another model id', async (t) => {
  let attempts = 0;
  const events: GatewayRequestCompletedEvent[] = [];
  const gateway = fixture(async () => {
    attempts += 1;
    return new Response('upstream rejected', { status: 503, headers: { 'content-type': 'text/plain' } });
  }, (event) => { events.push(event); });
  const server = createServer((request, response) => { void gateway.handle(request, response); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'vendor/public', messages: [] }),
  });
  assert.equal(response.status, 503);
  assert.equal(attempts, 1);
  assert.deepEqual(events, [{ protocol: 'openai_chat', publicModel: 'vendor/public', provider: 'vendor', status: 503, durationMs: events[0]?.durationMs }]);
  server.close();
  await once(server, 'close');
});

// Registers vendor plus the OpenCode service and OpenRouter providers so we can
// assert per-provider header and body treatment. Uses the existing mocked
// upstream pattern; no external calls.
function headerFixture(fetchImpl: typeof fetch) {
  const catalog = new Catalog();
  const register = (id: string, endpoint: string, model: string, upstream: string) => {
    catalog.registerProvider({
      id, displayName: id, credentialResolver: 'managed',
      models: [{
        id: model,
        displayName: model,
        intelligence: 'mid',
        speed: 40,
        pricing: [1.5, 3, 15],
      }],
      protocols: [{ protocol: 'openai_chat', endpoint, authScheme: 'bearer' }],
    });
  };
  register('vendor', 'https://upstream.test/v1/chat/completions', 'public', 'private');
  register('opencode-zen', 'https://opencode-zen.test/v1/chat/completions', 'zen-public', 'zen-private');
  register('opencode-go', 'https://opencode-go.test/v1/chat/completions', 'go-public', 'go-private');
  register('openrouter', 'https://openrouter.test/v1/chat/completions', 'free', 'free');
  const upstreamByPublic = { public: 'private', 'zen-public': 'zen-private', 'go-public': 'go-private', free: 'free' };
  return createModelGateway({
    catalog,
    fetch: fetchImpl,
    providers: {
      credential: async () => ({ value: 'upstream-secret' }),
      resolveUpstreamModel: (_provider, model) => upstreamByPublic[model as keyof typeof upstreamByPublic] ?? model,
      publicResponseModel: (provider, model, upstreamModel, publicModel) => {
        const logicalModel = publicModel.slice(provider.id.length + 1);
        return model === upstreamModel || model === logicalModel ? publicModel : model;
      },
      configureApiKey: async () => undefined,
    },
  });
}

function listen(gateway: ReturnType<typeof headerFixture>) {
  const server = createServer((request, response) => { void gateway.handle(request, response); });
  server.listen(0, '127.0.0.1');
  return server;
}

test('opencode service providers receive app UA and forwarded session', async (t) => {
  let seenUA: string | null = 'unset';
  let seenSession: string | null = 'unset';
  let seenAuth: string | null = 'unset';
  const gateway = headerFixture(async (_url, init) => {
    const h = new Headers(init?.headers);
    seenUA = h.get('user-agent');
    seenSession = h.get('x-opencode-session');
    seenAuth = h.get('authorization');
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });
  const server = listen(gateway);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer local', 'content-type': 'application/json', 'x-opencode-session': 'ses_opencode_1' },
    body: JSON.stringify({ model: 'opencode-zen/zen-public', messages: [] }),
  });
  assert.equal(seenUA, 'wrenyard');
  assert.equal(seenSession, 'ses_opencode_1');
  assert.equal(seenAuth, 'Bearer upstream-secret');
  server.close();
  await once(server, 'close');
});

test('non-opencode providers do not receive the session header', async (t) => {
  let seenSession: string | null = 'unset';
  const gateway = headerFixture(async (_url, init) => {
    seenSession = new Headers(init?.headers).get('x-opencode-session');
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });
  const server = listen(gateway);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer local', 'content-type': 'application/json', 'x-opencode-session': 'ses_opencode_1' },
    body: JSON.stringify({ model: 'vendor/public', messages: [] }),
  });
  assert.equal(seenSession, null);
  server.close();
  await once(server, 'close');
});

test('invalid x-opencode-session is omitted', async (t) => {
  for (const bad of ['a'.repeat(300), 'safe\rleak', 'safe\nleak', ['one', 'two']]) {
    let seenSession: string | null = 'unset';
    const gateway = headerFixture(async (_url, init) => {
      seenSession = new Headers(init?.headers).get('x-opencode-session');
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    const server = createServer((request, response) => {
      request.headers['x-opencode-session'] = bad;
      void gateway.handle(request, response);
    });
    t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const init: RequestInit = {
      method: 'POST',
      headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'opencode-zen/zen-public', messages: [] }),
    };
    await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/v1/chat/completions`, init);
    assert.equal(seenSession, null, `session not omitted for ${JSON.stringify(bad)}`);
    server.close();
    await once(server, 'close');
  }
});

test('429 response forwards retry-after and x-ratelimit headers for all providers', async (t) => {
  const gateway = headerFixture(async () => new Response('{"error":"rate limited"}', {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': '60',
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1700000000',
    },
  }));
  const server = listen(gateway);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'vendor/public', messages: [] }),
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(response.headers.get('x-ratelimit-limit'), '100');
  assert.equal(response.headers.get('x-ratelimit-remaining'), '0');
  assert.equal(response.headers.get('x-ratelimit-reset'), '1700000000');
  server.close();
  await once(server, 'close');
});

test('openrouter free request strips models and route without changing free id', async (t) => {
  let seenBody: Record<string, unknown> = {};
  const gateway = headerFixture(async (_url, init) => {
    seenBody = JSON.parse(String(init?.body));
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });
  const server = listen(gateway);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'openrouter/free',
      messages: [],
      models: ['openrouter/paid-backup', 'openrouter/free'],
      route: { fallback: true },
    }),
  });
  assert.equal(seenBody.model, 'free');
  assert.equal('models' in seenBody, false);
  assert.equal('route' in seenBody, false);
  server.close();
  await once(server, 'close');
});

// Registers CodeBuddy alongside the plain vendor provider and stubs the client
// identity loader, so product identity and conversation round headers can be
// asserted without a real installation. An undefined identity models an absent
// installed CLI.
function codeBuddyFixture(fetchImpl: typeof fetch, identity?: { platform: string; productName: string; version: string; deploymentType: string }) {
  const catalog = new Catalog();
  const register = (id: string, model: string, endpoint: string) => {
    catalog.registerProvider({
      id, displayName: id, credentialResolver: id === 'codebuddy' ? 'codebuddy' : 'managed',
      models: [{
        id: model,
        displayName: model,
        intelligence: 'mid',
        speed: 40,
        pricing: [1.5, 3, 15],
      }],
      protocols: [{ protocol: 'openai_chat', endpoint, authScheme: 'bearer' }],
    });
  };
  register('codebuddy', 'cb-public', 'https://codebuddy.test/v1/chat/completions');
  register('vendor', 'public', 'https://upstream.test/v1/chat/completions');
  return createModelGateway({
    catalog,
    fetch: fetchImpl,
    providers: {
      credential: async () => ({ value: 'upstream-secret' }),
      resolveUpstreamModel: (_provider, model) => model === 'public' ? 'private' : model,
      publicResponseModel: (provider, model, upstreamModel, publicModel) => {
        const logicalModel = publicModel.slice(provider.id.length + 1);
        return model === upstreamModel || model === logicalModel ? publicModel : model;
      },
      configureApiKey: async () => undefined,
      codeBuddyClientIdentity: async () => identity,
    },
  });
}

function codeBuddyRequest(port: number, scope: string | undefined, messages: unknown[]): Promise<Response> {
  const path = scope ? `/gateway/openai-chat/execution/${scope}/v1/chat/completions` : '/gateway/openai-chat/v1/chat/completions';
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer local', 'content-type': 'application/json', 'user-agent': 'wrenyard/1.0' },
    body: JSON.stringify({ model: 'codebuddy/cb-public', messages }),
  });
}

test('codebuddy requests carry the official product identity headers', async (t) => {
  let seen: Headers | undefined;
  const gateway = codeBuddyFixture(async (_url, init) => {
    seen = new Headers(init?.headers);
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }, { platform: 'CLI', productName: 'CodeBuddy', version: '2.117.2', deploymentType: 'SaaS' });
  const server = listen(gateway);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await codeBuddyRequest(address.port, 'exec_identity', [{ role: 'user', content: 'hi' }]);
  assert.equal(seen!.get('user-agent'), 'CLI/2.117.2 CodeBuddy/2.117.2 wrenyard/1.0');
  assert.equal(seen!.get('x-product'), 'SaaS');
  assert.equal(seen!.get('x-ide-type'), 'CLI');
  assert.equal(seen!.get('x-ide-name'), 'CLI');
  assert.equal(seen!.get('x-ide-version'), '2.117.2');
  assert.equal(seen!.get('x-requested-with'), 'XMLHttpRequest');
  assert.equal(seen!.get('x-agent-intent'), 'craft');
  server.close();
  await once(server, 'close');
});

test('codebuddy reuses the conversation request id across a tool hop and rotates it on a new turn', async (t) => {
  const seen: Headers[] = [];
  const gateway = codeBuddyFixture(async (_url, init) => {
    seen.push(new Headers(init?.headers));
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }, { platform: 'CLI', productName: 'CodeBuddy', version: '2.117.2', deploymentType: 'SaaS' });
  const server = listen(gateway);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await codeBuddyRequest(address.port, 'exec_round', [{ role: 'user', content: 'hi' }]);
  await codeBuddyRequest(address.port, 'exec_round', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'file' },
  ]);
  await codeBuddyRequest(address.port, 'exec_round', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'file' },
    { role: 'user', content: 'again' },
  ]);
  assert.equal(seen.length, 3);
  const [first, second, third] = seen as [Headers, Headers, Headers];
  assert.equal(second.get('x-conversation-request-id'), first.get('x-conversation-request-id'));
  assert.notEqual(third.get('x-conversation-request-id'), first.get('x-conversation-request-id'));
  assert.notEqual(second.get('x-conversation-message-id'), first.get('x-conversation-message-id'));
  assert.notEqual(second.get('x-request-id'), first.get('x-request-id'));
  assert.equal(seen.every((headers) => headers.get('x-conversation-id') === first.get('x-conversation-id')), true);
  server.close();
  await once(server, 'close');
});

test('different codebuddy execution scopes never share conversation identity', async (t) => {
  const seen: Headers[] = [];
  const gateway = codeBuddyFixture(async (_url, init) => {
    seen.push(new Headers(init?.headers));
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }, { platform: 'CLI', productName: 'CodeBuddy', version: '2.117.2', deploymentType: 'SaaS' });
  const server = listen(gateway);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const messages = [{ role: 'user', content: 'hi' }];
  await codeBuddyRequest(address.port, 'exec_one', messages);
  await codeBuddyRequest(address.port, 'exec_two', messages);
  const [first, second] = seen as [Headers, Headers];
  assert.notEqual(second.get('x-conversation-id'), first.get('x-conversation-id'));
  assert.notEqual(second.get('x-conversation-request-id'), first.get('x-conversation-request-id'));
  server.close();
  await once(server, 'close');
});

test('unscoped codebuddy requests group by their opening message prefix', async (t) => {
  const seen: Headers[] = [];
  const gateway = codeBuddyFixture(async (_url, init) => {
    seen.push(new Headers(init?.headers));
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }, { platform: 'CLI', productName: 'CodeBuddy', version: '2.117.2', deploymentType: 'SaaS' });
  const server = listen(gateway);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const opening = { role: 'user', content: 'hi' };
  const toolTurn = [
    opening,
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'file' },
  ];
  await codeBuddyRequest(address.port, undefined, [opening]);
  await codeBuddyRequest(address.port, undefined, toolTurn);
  await codeBuddyRequest(address.port, undefined, [{ role: 'user', content: 'different' }]);
  const [first, second, third] = seen as [Headers, Headers, Headers];
  assert.equal(second.get('x-conversation-id'), first.get('x-conversation-id'));
  assert.equal(second.get('x-conversation-request-id'), first.get('x-conversation-request-id'));
  assert.notEqual(third.get('x-conversation-id'), first.get('x-conversation-id'));
  server.close();
  await once(server, 'close');
});

test('non-codebuddy providers receive no codebuddy headers and keep their user agent', async (t) => {
  let seen: Headers | undefined;
  const gateway = codeBuddyFixture(async (_url, init) => {
    seen = new Headers(init?.headers);
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }, { platform: 'CLI', productName: 'CodeBuddy', version: '2.117.2', deploymentType: 'SaaS' });
  const server = listen(gateway);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/execution/exec_other/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer local', 'content-type': 'application/json', 'user-agent': 'wrenyard/1.0' },
    body: JSON.stringify({ model: 'vendor/public', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(seen!.get('user-agent'), 'wrenyard/1.0');
  for (const name of ['x-product', 'x-ide-type', 'x-ide-name', 'x-ide-version', 'x-requested-with', 'x-agent-intent', 'x-conversation-id', 'x-conversation-request-id', 'x-conversation-message-id']) {
    assert.equal(seen!.get(name), null, `${name} leaked to a non-CodeBuddy provider`);
  }
  server.close();
  await once(server, 'close');
});

test('codebuddy requests without an installed CLI keep round headers and no identity', async (t) => {
  let seen: Headers | undefined;
  const gateway = codeBuddyFixture(async (_url, init) => {
    seen = new Headers(init?.headers);
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });
  const server = listen(gateway);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await codeBuddyRequest(address.port, 'exec_missing', [{ role: 'user', content: 'hi' }]);
  assert.match(seen!.get('x-conversation-id')!, /^[0-9a-f]{32}$/u);
  assert.match(seen!.get('x-conversation-request-id')!, /^[0-9a-f]{32}$/u);
  assert.match(seen!.get('x-conversation-message-id')!, /^[0-9a-f]{32}$/u);
  assert.equal(seen!.get('x-conversation-message-id'), seen!.get('x-request-id'));
  assert.equal(seen!.get('x-requested-with'), 'XMLHttpRequest');
  assert.equal(seen!.get('x-agent-intent'), 'craft');
  assert.equal(seen!.get('x-product'), null);
  assert.equal(seen!.get('x-ide-type'), null);
  assert.equal(seen!.get('x-ide-name'), null);
  assert.equal(seen!.get('x-ide-version'), null);
  assert.equal(seen!.get('user-agent'), 'wrenyard/1.0');
  server.close();
  await once(server, 'close');
});

test('eight base64 image_url payloads above 16 MiB are forwarded upstream intact', async (t) => {
  // 8 x 2 MiB binary images expand to ~21 MiB of base64, well above the old
  // 16 MiB cap but within the 64 MiB budget.
  const binarySize = 2 * 1024 * 1024;
  const dataUrls = Array.from(
    { length: 8 },
    (_, index) => `data:image/png;base64,${Buffer.alloc(binarySize, index + 1).toString('base64')}`,
  );
  const payload = {
    model: 'vendor/public',
    messages: [{
      role: 'user',
      content: dataUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
    }],
  };
  const body = JSON.stringify(payload);
  assert.ok(Buffer.byteLength(body) > 16 * 1024 * 1024, 'payload must exceed the previous 16 MiB cap');

  let received: Record<string, unknown> | undefined;
  const gateway = fixture(async (_url, init) => {
    received = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });
  const server = createServer((request, response) => { void gateway.handle(request, response); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' }, body,
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.ok(received);
  // Every image_url survives the over-16 MiB hop byte-for-byte.
  assert.deepEqual(received.messages, payload.messages);
  server.close();
  await once(server, 'close');
});

test('a request body of exactly 64 MiB is accepted and one byte more is rejected with 413', async (t) => {
  const limit = 64 * 1024 * 1024;
  let upstreamCalls = 0;
  let forwardedModel: unknown;
  const gateway = fixture(async (_url, init) => {
    upstreamCalls += 1;
    forwardedModel = (JSON.parse(String(init?.body)) as Record<string, unknown>).model;
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });
  const server = createServer((request, response) => { void gateway.handle(request, response); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/gateway/openai-chat/v1/chat/completions`;
  const headers = { authorization: 'Bearer local', 'content-type': 'application/json' };

  // Pad the content string so JSON.stringify is exactly `bytes` ASCII bytes.
  const bodyOfSize = (bytes: number): string => {
    const overhead = JSON.stringify({ model: 'vendor/public', messages: [{ role: 'user', content: '' }] }).length;
    return JSON.stringify({ model: 'vendor/public', messages: [{ role: 'user', content: 'A'.repeat(bytes - overhead) }] });
  };

  let body = bodyOfSize(limit);
  assert.equal(Buffer.byteLength(body), limit);
  const accepted = await fetch(url, { method: 'POST', headers, body });
  assert.equal(accepted.status, 200);
  await accepted.text();
  assert.equal(upstreamCalls, 1);
  assert.equal(forwardedModel, 'private');

  body = bodyOfSize(limit + 1);
  assert.equal(Buffer.byteLength(body), limit + 1);
  const rejected = await fetch(url, { method: 'POST', headers, body });
  assert.equal(rejected.status, 413);
  await rejected.text();
  assert.equal(upstreamCalls, 1, 'oversize body must not reach upstream');
  server.close();
  await once(server, 'close');
});

// ChatGPT Responses forwarding. The real Catalog and provider runtime are used
// so the catalog's protocol boundary and the runtime's account-header binding
// and injected refresh are exercised end to end; only fetch and the Codex auth
// adapter are mocked. The managed credential store is empty so chatgpt is the
// only available provider.
function chatGptGateway(adapter: ChatGptGatewayAuthAdapter, fetchImpl: typeof fetch, readFile?: () => Promise<string>) {
  const catalog = createBuiltinCatalog();
  const providers = createBuiltinProviderRuntime({
    env: {},
    codexGatewayAuth: adapter,
    readFile: readFile ?? (async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
  });
  return { catalog, gateway: createModelGateway({ catalog, providers, fetch: fetchImpl }) };
}

function startGateway(gateway: ReturnType<typeof createModelGateway>) {
  const server = createServer((request, response) => { void gateway.handle(request, response); });
  server.listen(0, '127.0.0.1');
  return server;
}

test('chatgpt responses forwards instructions, input and tools with fixed stream/store', async (t) => {
  let seenUrl = '';
  let seenHeaders: Headers | undefined;
  let seenBody: Record<string, unknown> = {};
  const { gateway } = chatGptGateway({
    read: async () => ({ accessToken: 'gateway-token', accountId: 'acct-1' }),
    refresh: async (credential) => credential,
  }, async (url, init) => {
    seenUrl = String(url);
    seenHeaders = new Headers(init?.headers);
    seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response('data: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const server = startGateway(gateway);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const input = [{
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'ping' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ],
  }];
  const tools = [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }];
  const response = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-responses/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chatgpt/gpt-6.1-sol', instructions: 'custom system instructions', input, tools }),
  });
  assert.equal(response.status, 200);
  await response.text();

  // Pure forwarding: the upstream endpoint, model, instructions, every content
  // part and the tool definitions survive; only the required provider fields
  // are added.
  assert.equal(seenUrl, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(seenBody.model, 'gpt-6.1-sol');
  assert.equal(seenBody.stream, true);
  assert.equal(seenBody.store, false);
  assert.equal(seenBody.instructions, 'custom system instructions');
  assert.deepEqual(seenBody.input, input);
  assert.deepEqual(seenBody.tools, tools);
  assert.deepEqual(Object.keys(seenBody).sort(), ['input', 'instructions', 'model', 'store', 'stream', 'tools']);

  assert.equal(seenHeaders!.get('authorization'), 'Bearer gateway-token');
  assert.equal(seenHeaders!.get('chatgpt-account-id'), 'acct-1');
  assert.equal(seenHeaders!.get('originator'), 'codex-tui');
  assert.equal(seenHeaders!.get('accept'), 'text/event-stream');
  assert.equal(seenHeaders!.get('content-type'), 'application/json');
  assert.equal(seenHeaders!.get('user-agent'), 'codex-tui/0.154.0');
  assert.match(seenHeaders!.get('session_id')!, /^[0-9a-f-]{36}$/u);
  server.close();
  await once(server, 'close');
});

test('chatgpt responses refreshes the credential once on 401 and retries the identical request', async (t) => {
  const attempts: Array<{ authorization: string | null; account: string | null; body: Record<string, unknown> }> = [];
  let refreshCalls = 0;
  const { gateway } = chatGptGateway({
    read: async () => ({ accessToken: 'token-a', accountId: 'acct-a' }),
    refresh: async (credential, signal) => {
      refreshCalls += 1;
      assert.deepEqual(credential, { accessToken: 'token-a', accountId: 'acct-a' });
      assert.ok(signal instanceof AbortSignal);
      return { accessToken: 'token-b', accountId: 'acct-b' };
    },
  }, async (_url, init) => {
    const headers = new Headers(init?.headers);
    attempts.push({
      authorization: headers.get('authorization'),
      account: headers.get('chatgpt-account-id'),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    if (attempts.length === 1) return new Response('unauthorized', { status: 401, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });
  const server = startGateway(gateway);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-responses/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'chatgpt/gpt-6.1-sol',
      instructions: 'custom system instructions',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    }),
  });
  assert.equal(response.status, 200);
  await response.text();

  assert.equal(refreshCalls, 1);
  assert.equal(attempts.length, 2, 'exactly one retry');
  assert.equal(attempts[0]!.authorization, 'Bearer token-a');
  assert.equal(attempts[0]!.account, 'acct-a');
  assert.equal(attempts[1]!.authorization, 'Bearer token-b');
  assert.equal(attempts[1]!.account, 'acct-b');
  assert.deepEqual(attempts[1]!.body, attempts[0]!.body);
  assert.equal(attempts[1]!.body.stream, true);
  assert.equal(attempts[1]!.body.store, false);
  server.close();
  await once(server, 'close');
});

test('chatgpt responses does not retry a non-auth upstream failure', async (t) => {
  let attempts = 0;
  let refreshCalls = 0;
  const { gateway } = chatGptGateway({
    read: async () => ({ accessToken: 'token-a', accountId: 'acct-a' }),
    refresh: async (credential) => { refreshCalls += 1; return credential; },
  }, async () => {
    attempts += 1;
    return new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } });
  });
  const server = startGateway(gateway);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-responses/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chatgpt/gpt-6.1-sol', input: [] }),
  });
  assert.equal(response.status, 500);
  await response.text();
  assert.equal(attempts, 1);
  assert.equal(refreshCalls, 0);
  server.close();
  await once(server, 'close');
});

test('the gateway advertises chatgpt only under openai-responses and rejects Chat', async (t) => {
  const { catalog, gateway } = chatGptGateway({
    read: async () => ({ accessToken: 'gateway-token', accountId: 'acct-1' }),
    refresh: async (credential) => credential,
  }, async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
  const server = startGateway(gateway);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  const responses = await (await fetch(`${base}/gateway/openai-responses/v1/models`)).json() as { data: Array<{ id: string }> };
  assert.ok(responses.data.some((model) => model.id === 'chatgpt/gpt-6.1-sol'));
  const chat = await (await fetch(`${base}/gateway/openai-chat/v1/models`)).json() as { data: Array<{ id: string }> };
  assert.equal(chat.data.some((model) => model.id === 'chatgpt/gpt-6.1-sol'), false);

  // Catalog already owns the explicit unsupported-protocol error.
  assert.throws(
    () => catalog.resolveGatewayModel('openai_chat', 'chatgpt/gpt-6.1-sol'),
    /does not support openai_chat/u,
  );
  const rejected = await fetch(`${base}/gateway/openai-chat/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chatgpt/gpt-6.1-sol', messages: [] }),
  });
  assert.equal(rejected.status, 404);
  const payload = await rejected.json() as { error: { message: string } };
  assert.match(payload.error.message, /does not support openai_chat/u);
  server.close();
  await once(server, 'close');
});

test('a rejected chatgpt login leaves chatgpt unavailable without breaking other protocol directories', async (t) => {
  const { gateway } = chatGptGateway({
    read: async () => { throw new Error('no codex login'); },
    refresh: async (credential) => credential,
  }, async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
  async () => JSON.stringify({ openrouter: { type: 'api', key: 'managed-openrouter' } }));
  const server = startGateway(gateway);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  // The unrelated OpenAI Chat directory still resolves; a broken Codex login
  // must never reject the shared credential probe for every other provider.
  const chat = await fetch(`${base}/gateway/openai-chat/v1/models`);
  assert.equal(chat.status, 200);
  const chatModels = await chat.json() as { data: Array<{ id: string }> };
  assert.ok(chatModels.data.some((model) => model.id.startsWith('openrouter/')));

  // ChatGPT itself is simply absent from its own directory, not an error.
  const responses = await fetch(`${base}/gateway/openai-responses/v1/models`);
  assert.equal(responses.status, 200);
  const responseModels = await responses.json() as { data: Array<{ id: string }> };
  assert.equal(responseModels.data.some((model) => model.id === 'chatgpt/gpt-6.1-sol'), false);

  // Inference against the unavailable provider is an explicit 503, not a hang.
  const inference = await fetch(`${base}/gateway/openai-responses/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chatgpt/gpt-6.1-sol', input: [] }),
  });
  assert.equal(inference.status, 503);
  const inferencePayload = await inference.json() as { error: { type: string } };
  assert.equal(inferencePayload.error.type, 'credential_unavailable');
  server.close();
  await once(server, 'close');
});

test('a failed chatgpt refresh forwards the original 401 body without retrying', async (t) => {
  let attempts = 0;
  let refreshCalls = 0;
  const { gateway } = chatGptGateway({
    read: async () => ({ accessToken: 'token-a', accountId: 'acct-a' }),
    refresh: async () => { refreshCalls += 1; throw new Error('refresh unavailable'); },
  }, async () => {
    attempts += 1;
    return new Response('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } });
  });
  const server = startGateway(gateway);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-responses/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chatgpt/gpt-6.1-sol', input: [] }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
  assert.equal(refreshCalls, 1);
  assert.equal(attempts, 1, 'a failed refresh must not retry');
  server.close();
  await once(server, 'close');
});

test('a chatgpt retry transport failure reports 502 after one refresh and two attempts', async (t) => {
  let attempts = 0;
  let refreshCalls = 0;
  const { gateway } = chatGptGateway({
    read: async () => ({ accessToken: 'token-a', accountId: 'acct-a' }),
    refresh: async () => { refreshCalls += 1; return { accessToken: 'token-b', accountId: 'acct-b' }; },
  }, async () => {
    attempts += 1;
    if (attempts === 1) return new Response('unauthorized', { status: 401, headers: { 'content-type': 'application/json' } });
    throw new Error('retry transport down');
  });
  const server = startGateway(gateway);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-responses/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chatgpt/gpt-6.1-sol', input: [] }),
  });
  // The retry failure must surface as the outer 502, never as the canceled 401.
  assert.equal(response.status, 502);
  await response.text();
  assert.equal(refreshCalls, 1);
  assert.equal(attempts, 2, 'exactly one refresh and one retry');
  server.close();
  await once(server, 'close');
});

test('an abort during chatgpt refresh neither retries nor falls back to the original 401', async (t) => {
  let attempts = 0;
  let refreshCalls = 0;
  let gateway!: ReturnType<typeof createModelGateway>;
  const { gateway: created } = chatGptGateway({
    read: async () => ({ accessToken: 'token-a', accountId: 'acct-a' }),
    refresh: async () => {
      refreshCalls += 1;
      // Model the gateway shutting down mid-refresh, aborting the in-flight request.
      await gateway.close();
      throw new Error('aborted');
    },
  }, async () => {
    attempts += 1;
    return new Response('unauthorized', { status: 401, headers: { 'content-type': 'application/json' } });
  });
  gateway = created;
  const server = startGateway(gateway);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-responses/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chatgpt/gpt-6.1-sol', input: [] }),
  });
  assert.equal(response.status, 499);
  await response.text();
  assert.equal(refreshCalls, 1);
  assert.equal(attempts, 1, 'an aborted refresh must not retry');
  server.close();
  await once(server, 'close');
});
