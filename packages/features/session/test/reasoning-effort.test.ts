/**
 * Focused offline tests for unified reasoning-effort handling in the session
 * feature: the auxiliary role ladder, the header/body split on both drivers,
 * and the level resolution recorded in the ledger `call` event.
 *
 * No model, network or credential is ever used: the drivers are driven with an
 * injected fake `fetch`, and the call runner with a fake `ModelDriver`.
 */
import assert from 'node:assert/strict';
import { createCodeBuddyModels } from '../../../providers/src/codebuddy/models.ts';
import test from 'node:test';
import type { WrenyardGatewayConnection } from '@wrenyard/control-client';
import { createCallRunner, ModelCallError, resolveAuxiliaryReasoningEffort } from '../src/calls.ts';
import { createGatewayDriver, REASONING_EFFORT_HEADER, type DriverRequest, type ModelDriver } from '../src/driver.ts';
import { createResponsesDriver } from '../src/responses-driver.ts';

const CONNECTION: WrenyardGatewayConnection = {
  openaiChatBaseUrl: 'http://gateway.test/v1',
  openaiResponsesBaseUrl: 'http://gateway.test/v1',
  anthropicBaseUrl: 'http://gateway.test',
  token: 'test-token',
  models: [],
};

function baseRequest(overrides: Partial<DriverRequest> = {}): DriverRequest {
  return {
    model: 'openai/gpt-6.1-sol',
    reasoningEffort: 'medium',
    messages: [{ role: 'user', content: 'hello' }],
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface Capture {
  headers?: Headers;
  body?: Record<string, unknown>;
}

function captureFetch(payload: unknown, capture: Capture): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    capture.headers = new Headers(init?.headers);
    capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

// ─── auxiliary role ladder ─────────────────────────────────────────────────

test('an auxiliary role picks the earliest shared expected level', () => {
  // Fully supported route: the first declared expectation wins.
  assert.equal(resolveAuxiliaryReasoningEffort('title', ['none', 'low', 'high']), 'none');
  assert.equal(resolveAuxiliaryReasoningEffort('reply', ['low', 'high', 'max']), 'low');
  assert.equal(resolveAuxiliaryReasoningEffort('memory-search', ['medium', 'high']), 'medium');
});

test('an auxiliary role falls back to the nearest supported level at or above the first expectation', () => {
  // No shared level: nearest >= first expectation, else the highest supported.
  assert.equal(resolveAuxiliaryReasoningEffort('doc-search', ['high']), 'high');
  assert.equal(resolveAuxiliaryReasoningEffort('compile', ['low', 'max']), 'low');
  // The `reason` role has no declared ladder, and an unknown route ladder is skipped.
  assert.equal(resolveAuxiliaryReasoningEffort('reason', ['low']), undefined);
  assert.equal(resolveAuxiliaryReasoningEffort('title', undefined), undefined);
});

// ─── driver header/body split ──────────────────────────────────────────────

test('the chat driver sends the effort as a header and leaves it out of the body', async () => {
  const capture: Capture = {};
  const driver = createGatewayDriver(CONNECTION, {
    fetch: captureFetch({ choices: [{ message: { content: 'ok' } }] }, capture),
  });

  await driver.complete(baseRequest({ reasoningEffort: 'medium' }));

  assert.equal(capture.headers?.get(REASONING_EFFORT_HEADER), 'medium');
  assert.equal('reasoning_effort' in (capture.body ?? {}), false);
});

test('the chat driver always sends the explicitly required effort', async () => {
  const capture: Capture = {};
  const driver = createGatewayDriver(CONNECTION, {
    fetch: captureFetch({ choices: [{ message: { content: 'ok' } }] }, capture),
  });

  await driver.complete(baseRequest());

  assert.equal(capture.headers?.get(REASONING_EFFORT_HEADER), 'medium');
});

test('the responses driver sends the effort as a header and keeps only the summary in the body', async () => {
  const capture: Capture = {};
  const driver = createResponsesDriver(CONNECTION, {
    fetch: captureFetch({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
    }, capture),
  });

  await driver.complete(baseRequest({ reasoningEffort: 'xhigh' }));

  assert.equal(capture.headers?.get(REASONING_EFFORT_HEADER), 'xhigh');
  assert.deepEqual(capture.body?.reasoning, { summary: 'auto' });
});

// ─── call runner: explicit and auxiliary resolution recorded in the ledger ──

interface Captured {
  events: { type: string; role?: string; status?: string; reasoningEffort?: string; requestedReasoningEffort?: string }[];
  request?: DriverRequest;
}

function fakeDriver(captured: Captured): ModelDriver {
  return {
    async complete(request: DriverRequest) {
      captured.request = request;
      return { text: 'ok', toolCalls: [] };
    },
  };
}

function makeRunner(captured: Captured, cheapModel = 'openai/gpt-6.1-sol') {
  return createCallRunner({
    driver: fakeDriver(captured),
    cheapModel: () => cheapModel,
    append: (event) => { captured.events.push(event as Captured['events'][number]); },
  });
}

test('an explicit reason level is validated against the route and recorded', async () => {
  const captured: Captured = { events: [] };
  const runner = makeRunner(captured);
  await runner.run({
    callId: 'c-ok',
    role: 'reason',
    messages: [{ role: 'user', content: 'hi' }],
    layers: {},
    reason: { provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: 'high' },
    signal: new AbortController().signal,
  });

  assert.equal(captured.request?.reasoningEffort, 'high');
  const call = captured.events.find((event) => event.type === 'call');
  assert.equal(call?.status, 'ok');
  assert.equal(call?.reasoningEffort, 'high');
  assert.equal(call?.requestedReasoningEffort, 'high');
});

test('an unsupported explicit reason level fails before the driver and records the request', async () => {
  const captured: Captured = { events: [] };
  const runner = makeRunner(captured);
  await assert.rejects(
    runner.run({
      callId: 'c-bad',
      role: 'reason',
      messages: [{ role: 'user', content: 'hi' }],
      layers: {},
      // `cursor/composer-2.5` materializes only `high`.
      reason: { provider: 'cursor', model: 'composer-2.5', reasoningEffort: 'low' },
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ModelCallError,
  );

  assert.equal(captured.request, undefined, 'the driver must not be called');
  const call = captured.events.find((event) => event.type === 'call');
  assert.equal(call?.status, 'failed');
  assert.equal(call?.requestedReasoningEffort, 'low');
  assert.equal(call?.reasoningEffort, undefined);
});

test('a missing explicit reason level fails before the driver', async () => {
  const captured: Captured = { events: [] };
  const runner = makeRunner(captured);
  await assert.rejects(
    runner.run({
      callId: 'c-missing',
      role: 'reason',
      messages: [{ role: 'user', content: 'hi' }],
      layers: {},
      // The public API types this as required; a runtime gap must still fail.
      reason: { provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: undefined as unknown as 'high' },
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ModelCallError,
  );

  assert.equal(captured.request, undefined, 'the driver must not be called');
  const call = captured.events.find((event) => event.type === 'call');
  assert.equal(call?.status, 'failed');
  assert.equal(call?.reasoningEffort, undefined);
});

test('an auxiliary role resolves its effort from the route ladder and records requested and actual', async () => {
  const captured: Captured = { events: [] };
  const runner = makeRunner(captured);
  await runner.run({
    callId: 'c-aux',
    role: 'title',
    messages: [{ role: 'user', content: 'hi' }],
    layers: {},
    signal: new AbortController().signal,
  });

  // The whole route ladder is available, so the first expectation (`none`) wins.
  assert.equal(captured.request?.reasoningEffort, 'none');
  const call = captured.events.find((event) => event.type === 'call');
  assert.equal(call?.status, 'ok');
  assert.equal(call?.reasoningEffort, 'none');
  assert.equal(call?.requestedReasoningEffort, 'none');
});

test('runtime-only CodeBuddy route supplies the auxiliary call ladder', async () => {
  const { definition } = createCodeBuddyModels([{ id: 'claude-opus-5-5' }]);
  const captured: Captured = { events: [] };
  const runner = createCallRunner({
    driver: fakeDriver(captured),
    cheapModel: () => 'codebuddy/claude-opus-5-5',
    resolveProvider: id => id === 'codebuddy' ? definition : undefined,
    append: event => { captured.events.push(event as Captured['events'][number]); },
  });
  await runner.run({ callId: 'dynamic-codebuddy', role: 'title', messages: [{ role: 'user', content: 'hi' }], layers: {}, signal: new AbortController().signal });
  assert.equal(captured.request?.reasoningEffort, 'none');
  assert.equal(captured.events.find(event => event.type === 'call')?.reasoningEffort, 'none');
});

test('runtime CodeBuddy DeepSeek auxiliary calls choose none and record it', async () => {
  for (const model of ['deepseek-v4.1-flash', 'deepseek-v4-pro']) {
    const { definition } = createCodeBuddyModels([{ id: model }]);
    const captured: Captured = { events: [] };
    const runner = createCallRunner({
      driver: fakeDriver(captured),
      cheapModel: () => 'codebuddy/' + model,
      resolveProvider: id => id === 'codebuddy' ? definition : undefined,
      append: event => { captured.events.push(event as Captured['events'][number]); },
    });
    await runner.run({ callId: 'deepseek-' + model, role: 'title', messages: [{ role: 'user', content: 'hi' }], layers: {}, signal: new AbortController().signal });
    assert.equal(captured.request?.reasoningEffort, 'none');
    const call = captured.events.find(event => event.type === 'call');
    assert.equal(call?.status, 'ok');
    assert.equal(call?.requestedReasoningEffort, 'none');
    assert.equal(call?.reasoningEffort, 'none');
  }
});
