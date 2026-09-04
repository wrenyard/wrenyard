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
    models: [{ id: 'public', displayName: 'Public' }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://upstream.test/v1/chat/completions', authScheme: 'bearer' }],
  });
  return createModelGateway({
    catalog,
    fetch: fetchImpl,
    onRequestCompleted,
    providers: {
      credential: async () => ({ value: 'upstream-secret' }),
      resolveUpstreamModel: (_provider, model) => model === 'public' ? 'private' : model,
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
