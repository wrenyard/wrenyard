import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import type { Catalog } from '@wrenyard/providers/catalog';
import type { ProviderRuntime } from '@wrenyard/providers';
import type { ProviderDefinition } from '@wrenyard/providers/base';
import { createModelGateway, type GatewayRequestCompletedEvent, type ModelGateway } from '../src/index.ts';

/**
 * Local, deterministic pipeline tests: a real loopback HTTP server serves the
 * Gateway and a fake `fetch` stands in for the upstream, so no live provider is
 * ever contacted and nothing waits on wall time beyond the injected deadlines.
 */

const INFERENCE_PATH = '/gateway/openai-chat/v1/chat/completions';
const OK_SSE = ['data: {"id":"r1","choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n'];

/** A fake clock; every test advances it explicitly. */
function fakeClock(start = Date.parse('2026-01-01T00:00:00.000Z')) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const provider = { id: 'test', protocols: [{ protocol: 'openai_chat', authScheme: 'bearer' }] } as unknown as ProviderDefinition;

function makeGateway(options: {
  fetch: typeof globalThis.fetch;
  now: () => number;
  onRequestCompleted?: (event: GatewayRequestCompletedEvent) => void;
}): ModelGateway {
  const catalog = {
    providers: () => [provider],
    resolveGatewayModel: (_protocol: string, selector: { model: string; provider?: string }) => {
      const model = selector.model;
      if (model !== 'alpha' && model !== 'beta') throw new Error(`Unknown model ${model}`);
      return {
        provider, model: { id: model, reasoningEfforts: ['none'] },
        capability: { endpoint: 'http://upstream.test/v1', protocol: 'openai_chat' },
        publicId: `test/${model}`, upstreamModel: model,
      };
    },
  } as unknown as Catalog;
  const providers = {
    credential: async () => ({ value: 'secret' }),
    quotaPools: () => [],
    resolveUpstreamModel: (_provider: unknown, upstreamModel: string) => upstreamModel,
  } as unknown as ProviderRuntime;
  return createModelGateway({
    catalog, providers, fetch: options.fetch, now: options.now,
    ...(options.onRequestCompleted === undefined ? {} : { onRequestCompleted: options.onRequestCompleted }),
  });
}

async function withServer<T>(gateway: ModelGateway, run: (port: number) => Promise<T>): Promise<T> {
  const server = createServer((request, response) => { void gateway.handle(request, response).catch(() => undefined); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    return await run(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function post(port: number, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${INFERENCE_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => '');
  return { status: response.status, headers: response.headers, text };
}

/** A `fetch` whose promise only rejects when the request is aborted. */
function hangingFetch(counter: { calls: number }): typeof globalThis.fetch {
  return ((_url: unknown, init: RequestInit) => {
    counter.calls += 1;
    const signal = init.signal!;
    return new Promise((_resolve, reject) => {
      const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
    });
  }) as unknown as typeof globalThis.fetch;
}

/** A `fetch` that resolves with a stream which never closes and errors on abort. */
function holdingStreamFetch(counter: { calls: number }): typeof globalThis.fetch {
  return ((_url: unknown, init: RequestInit) => {
    counter.calls += 1;
    const signal = init.signal!;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"r1","choices":[{"delta":{"content":"hi"}}]}\n\n'));
        const fail = () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
      },
    });
    return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  }) as unknown as typeof globalThis.fetch;
}

/** A `fetch` that ignores its abort signal and never settles at all. */
function uncooperativeFetch(counter: { calls: number }): typeof globalThis.fetch {
  return ((_url: unknown, _init: RequestInit) => {
    counter.calls += 1;
    return new Promise<Response>(() => undefined);
  }) as unknown as typeof globalThis.fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close(); } }), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
}

test('a hung streaming route times out without poisoning route availability', async () => {
  const clock = fakeClock();
  const counter = { calls: 0 };
  const completed: GatewayRequestCompletedEvent[] = [];
  const fetchImpl: typeof globalThis.fetch = (url, init) => {
    if (counter.calls === 0) return hangingFetch(counter)(url, init ?? {});
    counter.calls += 1;
    return Promise.resolve(sseResponse(OK_SSE));
  };
  const gateway = makeGateway({ fetch: fetchImpl, now: clock.now, onRequestCompleted: (event) => { completed.push(event); } });
  await withServer(gateway, async (port) => {
    const hungPromise = post(port, { model: 'alpha', stream: true }, { 'x-wrenyard-first-response-timeout': '1', 'x-wrenyard-gateway-attempt': 'a1' });
    clock.advance(1_000);
    const hung = await hungPromise;
    assert.equal(hung.status, 504);
    assert.equal(gateway.routeStatus('test/alpha'), undefined);
    const event = completed.find((entry) => entry.publicModel === 'test/alpha');
    assert.equal(event?.faultReason, 'timeout');
    assert.equal(event?.routeState, undefined);

    const next = await post(port, { model: 'alpha', stream: true });
    assert.equal(next.status, 200);
    assert.equal(counter.calls, 2);
  });
  await gateway.close();
});

test('a transport failure is reported but never blocks the route', async () => {
  const clock = fakeClock();
  const gateway = makeGateway({ fetch: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch, now: clock.now });
  await withServer(gateway, async (port) => {
    const response = await post(port, { model: 'alpha', stream: true });
    assert.equal(response.status, 502);
    assert.equal(gateway.routeStatus('test/alpha'), undefined);
    assert.equal(gateway.routeStatus('test/beta'), undefined);
  });
  await gateway.close();
});

test('a 5xx and a caller-caused 400 never poison a route', async () => {
  const clock = fakeClock();
  let status = 500;
  const gateway = makeGateway({
    fetch: (() => Promise.resolve(jsonResponse(status, status >= 500
      ? { error: { message: 'boom', type: 'server_error', code: 'internal_error' } }
      : { error: { message: 'bad request', type: 'invalid_request_error', code: 'bad_field' } }))) as unknown as typeof globalThis.fetch,
    now: clock.now,
  });
  await withServer(gateway, async (port) => {
    const failed = await post(port, { model: 'alpha', stream: true });
    assert.equal(failed.status, 500);
    assert.equal(gateway.routeStatus('test/alpha'), undefined);

    status = 400;
    const invalid = await post(port, { model: 'beta', stream: true });
    assert.equal(invalid.status, 400);
    // A request the caller must fix never poisons a route.
    assert.equal(gateway.routeStatus('test/beta'), undefined);
  });
  await gateway.close();
});

test('a server-fault in-stream frame after HTTP 200 never poisons a route', async () => {
  const clock = fakeClock();
  const gateway = makeGateway({
    fetch: (() => Promise.resolve(sseResponse(['data: {"error":{"message":"overloaded","type":"server_error","code":"overloaded_error"}}\n\n']))) as unknown as typeof globalThis.fetch,
    now: clock.now,
  });
  await withServer(gateway, async (port) => {
    const response = await post(port, { model: 'alpha', stream: true });
    assert.equal(response.status, 200);
    assert.equal(gateway.routeStatus('test/alpha'), undefined);
  });
  await gateway.close();
});

test('an explicit in-stream rate-limit frame still poisons the pool', async () => {
  const clock = fakeClock();
  const gateway = makeGateway({
    fetch: (() => Promise.resolve(sseResponse(['data: {"error":{"message":"slow down","type":"rate_limit_error","code":"rate_limit_exceeded"}}\n\n']))) as unknown as typeof globalThis.fetch,
    now: clock.now,
  });
  await withServer(gateway, async (port) => {
    const response = await post(port, { model: 'alpha', stream: true });
    assert.equal(response.status, 200);
    assert.equal(gateway.routeStatus('test/alpha')?.faultKind, 'rate_limited');
    assert.equal(gateway.routeStatus('test/alpha')?.phase, 'open');
  });
  await gateway.close();
});

test('a caller-benign stream frame never poisons a route', async () => {
  const clock = fakeClock();
  const gateway = makeGateway({
    fetch: (() => Promise.resolve(sseResponse(['data: {"error":{"message":"filtered","type":"content_filter","code":"content_filter"}}\n\n']))) as unknown as typeof globalThis.fetch,
    now: clock.now,
  });
  await withServer(gateway, async (port) => {
    const response = await post(port, { model: 'alpha', stream: true });
    assert.equal(response.status, 200);
    assert.equal(gateway.routeStatus('test/alpha'), undefined);
  });
  await gateway.close();
});

test('a provider-scoped fault blocks a sibling model without upstream traffic', async () => {
  const clock = fakeClock();
  const counter = { calls: 0 };
  const gateway = makeGateway({
    fetch: ((_url: unknown, _init: RequestInit) => { counter.calls += 1; return Promise.resolve(jsonResponse(401, { error: { message: 'bad key', type: 'authentication_error', code: 'invalid_api_key' } })); }) as unknown as typeof globalThis.fetch,
    now: clock.now,
  });
  await withServer(gateway, async (port) => {
    const unauthorized = await post(port, { model: 'alpha', stream: true });
    assert.equal(unauthorized.status, 401);
    assert.equal(gateway.routeStatus('test/beta')?.faultKind, 'auth_failed');
    assert.equal(gateway.routeStatus('test/beta')?.phase, 'open');

    const calls = counter.calls;
    const blocked = await post(port, { model: 'beta', stream: true });
    assert.equal(blocked.status, 503);
    assert.equal(counter.calls, calls);
  });
  await gateway.close();
});

test('a completed-request client disconnect aborts upstream but records no route fault', async () => {
  const clock = fakeClock();
  const counter = { calls: 0 };
  const gateway = makeGateway({ fetch: hangingFetch(counter), now: clock.now });
  await withServer(gateway, async (port) => {
    await new Promise<void>((resolve) => {
      const request = httpRequest({ host: '127.0.0.1', port, path: INFERENCE_PATH, method: 'POST', headers: { 'content-type': 'application/json' } });
      request.on('error', () => resolve());
      request.write(JSON.stringify({ model: 'alpha', stream: true }));
      setTimeout(() => { request.destroy(); resolve(); }, 20);
    });
    await delay(40);
    // The client vanished before any deadline: neutral, never a provider fault.
    assert.equal(gateway.routeStatus('test/alpha'), undefined);
  });
  await gateway.close();
});

test('the trusted deadline bounds a stalled stream, not only the response headers', async () => {
  const clock = fakeClock();
  const counter = { calls: 0 };
  const completed: GatewayRequestCompletedEvent[] = [];
  const gateway = makeGateway({ fetch: holdingStreamFetch(counter), now: clock.now, onRequestCompleted: (event) => { completed.push(event); } });
  await withServer(gateway, async (port) => {
    const pending = post(port, { model: 'alpha', stream: true }, { 'x-wrenyard-first-response-timeout': '1', 'x-wrenyard-gateway-attempt': 's1' });
    clock.advance(1_000);
    await pending.catch(() => undefined);
    assert.equal(gateway.routeStatus('test/alpha'), undefined);
    assert.equal(completed.find((event) => event.publicModel === 'test/alpha')?.status, 504);
  });
  await gateway.close();
});
