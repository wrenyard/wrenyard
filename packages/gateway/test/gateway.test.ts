import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { Catalog } from '@wrenyard/catalog';
import { createModelGateway, type GatewayRequestCompletedEvent } from '../src/index.ts';

function fixture(
  fetchImpl: typeof fetch,
  onRequestCompleted?: Parameters<typeof createModelGateway>[0]['onRequestCompleted'],
) {
  const catalog = new Catalog();
  catalog.registerProvider({
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'forge-managed',
    models: [{
      id: 'public',
      displayName: 'Public',
      speed: { tps: 40, source: 'gateway-test', checkedAt: '2026-09-09' },
    }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://upstream.test/v1/chat/completions', authScheme: 'bearer' }],
  });
  return createModelGateway({
    catalog,
    fetch: fetchImpl,
    onRequestCompleted,
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

test('replaces only model and upstream auth, then streams the response', async () => {
  let seenBody: unknown;
  let seenAuth: string | null = null;
  const gateway = fixture(async (_url, init) => {
    seenBody = JSON.parse(String(init?.body));
    seenAuth = new Headers(init?.headers).get('authorization');
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('one')); controller.enqueue(new TextEncoder().encode('two')); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const server = createServer((request, response) => { void gateway.handle(request, response); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'vendor/public', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  assert.equal(await response.text(), 'onetwo');
  assert.deepEqual(seenBody, { model: 'private', messages: [{ role: 'user', content: 'hi' }], stream: true });
  assert.equal(seenAuth, 'Bearer upstream-secret');
  server.close();
  await once(server, 'close');
});

test('normalizes an upstream JSON response model back to the public model id', async () => {
  const gateway = fixture(async () => new Response(JSON.stringify({
    id: 'chatcmpl-test',
    model: 'private',
    choices: [{ message: { role: 'assistant', content: 'private remains content' } }],
  }), { headers: { 'content-type': 'application/json' } }));
  const server = createServer((request, response) => { void gateway.handle(request, response); });
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

test('normalizes split SSE model fields without changing event content or tool calls', async () => {
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

test('/models only returns credential-available protocol models', async () => {
  const gateway = fixture(fetch);
  const connection = await gateway.connection('http://127.0.0.1:8787');
  assert.deepEqual(connection.models.map((entry) => entry.publicId), ['vendor/public']);
  assert.equal(connection.openaiChatBaseUrl, 'http://127.0.0.1:8787/gateway/openai-chat/v1');
});

test('an upstream failure is returned once without retrying another model id', async () => {
  let attempts = 0;
  const events: GatewayRequestCompletedEvent[] = [];
  const gateway = fixture(async () => {
    attempts += 1;
    return new Response('upstream rejected', { status: 503, headers: { 'content-type': 'text/plain' } });
  }, (event) => { events.push(event); });
  const server = createServer((request, response) => { void gateway.handle(request, response); });
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
      id, displayName: id, credentialResolver: 'forge-managed',
      models: [{
        id: model,
        displayName: model,
        speed: { tps: 40, source: 'gateway-test', checkedAt: '2026-09-09' },
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

test('opencode service providers receive app UA and forwarded session', async () => {
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
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await fetch(`http://127.0.0.1:${address.port}/gateway/openai-chat/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer local', 'content-type': 'application/json', 'x-opencode-session': 'ses_opencode_1' },
    body: JSON.stringify({ model: 'opencode-zen/zen-public', messages: [] }),
  });
  assert.equal(seenUA, 'wrenyard/1.0.0-dev.23');
  assert.equal(seenSession, 'ses_opencode_1');
  assert.equal(seenAuth, 'Bearer upstream-secret');
  server.close();
  await once(server, 'close');
});

test('non-opencode providers do not receive the session header', async () => {
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

test('invalid x-opencode-session is omitted', async () => {
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

test('429 response forwards retry-after and x-ratelimit headers for all providers', async () => {
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

test('openrouter free request strips models and route without changing free id', async () => {
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
