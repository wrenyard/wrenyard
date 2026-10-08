/**
 * Focused offline tests for main/auxiliary inference driver selection.
 *
 * Every case drives the real {@link createInferenceDriver} (and the shared
 * {@link selectInferenceMode} policy) with an injected fake gateway and fake
 * `fetch`; no model, network, credential or E2E call is ever made. The built-in
 * provider catalog is the real one, so the selection under test is the exact
 * production policy rather than a reimplementation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { WrenyardGatewayConnection } from '@wrenyard/control-client';
import { createBuiltinCatalog, createCodeBuddy, type ProviderDefinition } from '@wrenyard/providers';
import type { DriverRequest } from '../src/driver.ts';
import { createInferenceDriver } from '../src/inference.ts';
import { selectInferenceMode } from '../src/inference-mode.ts';

const CONNECTION: WrenyardGatewayConnection = {
  openaiChatBaseUrl: 'http://gateway.test/v1',
  openaiResponsesBaseUrl: 'http://gateway.test/v1',
  anthropicBaseUrl: 'http://gateway.test',
  token: 'test-token',
  models: [],
};

const builtinCatalog = createBuiltinCatalog();
const builtinProvider = (id: string) => builtinCatalog.provider(id);

function baseRequest(overrides: Partial<DriverRequest> = {}): DriverRequest {
  return {
    model: 'openai/gpt-6.1-sol',
    reasoningEffort: 'medium',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
    ],
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface Capture {
  url?: string;
  init?: RequestInit;
}

/** A fake gateway that counts acquisitions and returns the test connection. */
function fakeGateway(counter: { calls: number }): () => Promise<WrenyardGatewayConnection> {
  return async () => {
    counter.calls += 1;
    return CONNECTION;
  };
}

function fakeFetch(response: Response, capture: Capture = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url);
    capture.init = init;
    return response;
  }) as typeof fetch;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}

test('the shared selector prefers chat when both protocols are declared', () => {
  // Chat precedence is a property of the one shared policy every selection
  // site uses; it is asserted here through the real selector.
  assert.equal(selectInferenceMode(['openai_chat', 'openai_responses']), 'openai_chat');
  assert.equal(selectInferenceMode(['openai_responses']), 'openai_responses');
  assert.equal(selectInferenceMode(['anthropic_messages', 'openai_responses']), 'openai_responses');
  assert.equal(selectInferenceMode([]), undefined);
});

test('auxiliary requests always use the chat driver regardless of provider protocol', async () => {
  const gateway = { calls: 0 };
  const capture: Capture = {};
  const driver = createInferenceDriver(fakeGateway(gateway), {
    resolveProvider: builtinProvider,
    fetch: fakeFetch(jsonResponse({ choices: [{ message: { content: 'hi' } }] }), capture),
  });

  // The model belongs to a Responses-only provider, but an auxiliary request
  // has no provider protocol lookup and must stay on chat.
  const result = await driver.complete(baseRequest({ model: 'openai/gpt-6.1-sol' }));

  assert.equal(gateway.calls, 1);
  assert.equal(result.text, 'hi');
  assert.equal(capture.url, 'http://gateway.test/v1/chat/completions');
  const body = JSON.parse(String(capture.init?.body)) as Record<string, unknown>;
  assert.equal('tools' in body, false);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'hello' },
  ]);
});

test('a main request on a chat provider uses the chat driver', async () => {
  const gateway = { calls: 0 };
  const capture: Capture = {};
  const driver = createInferenceDriver(fakeGateway(gateway), {
    resolveProvider: builtinProvider,
    fetch: fakeFetch(jsonResponse({ choices: [{ message: { content: 'chat answer' } }] }), capture),
  });

  const result = await driver.complete(baseRequest({ model: 'deepseek/deepseek-flash', actionTool: true }));

  assert.equal(gateway.calls, 1);
  assert.equal(capture.url, 'http://gateway.test/v1/chat/completions');
  assert.equal(result.text, 'chat answer');
});

test('a main request on a Responses-only provider uses the Responses driver', async () => {
  const gateway = { calls: 0 };
  const capture: Capture = {};
  const driver = createInferenceDriver(fakeGateway(gateway), {
    resolveProvider: builtinProvider,
    fetch: fakeFetch(jsonResponse({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses answer' }] }],
    }), capture),
  });

  const result = await driver.complete(baseRequest({ model: 'openai/gpt-6.1-sol', actionTool: true }));

  assert.equal(gateway.calls, 1);
  assert.equal(capture.url, 'http://gateway.test/v1/responses');
  assert.equal(result.text, 'responses answer');
  const body = JSON.parse(String(capture.init?.body)) as Record<string, unknown>;
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
});

test('unsupported provider, model and client-restricted model fail explicitly without any call', async () => {
  const cases: readonly { model: string; pattern: RegExp }[] = [
    { model: 'does-not-exist/model', pattern: /Unknown inference provider/u },
    { model: 'deepseek/does-not-exist', pattern: /Unknown inference model/u },
    { model: 'opencode-zen/mimo-v2.5-free', pattern: /restricted to specific clients/u },
  ];

  for (const { model, pattern } of cases) {
    const gateway = { calls: 0 };
    let fetched = 0;
    const driver = createInferenceDriver(fakeGateway(gateway), {
    resolveProvider: builtinProvider,
      fetch: (async () => { fetched += 1; return jsonResponse({}); }) as typeof fetch,
    });

    await assert.rejects(driver.complete(baseRequest({ model, actionTool: true })), pattern);
    assert.equal(gateway.calls, 0, `gateway was acquired for ${model}`);
    assert.equal(fetched, 0, `fetch was called for ${model}`);
  }
});

test('a provider without a gateway protocol is rejected before any gateway or model call', async () => {
  const gateway = { calls: 0 };
  let fetched = 0;
  const driver = createInferenceDriver(fakeGateway(gateway), {
    resolveProvider: builtinProvider,
    fetch: (async () => { fetched += 1; return jsonResponse({}); }) as typeof fetch,
  });

  await assert.rejects(
    driver.complete(baseRequest({ model: 'cursor/composer-2.5', actionTool: true })),
    /has no supported runtime/u,
  );
  assert.equal(gateway.calls, 0);
  assert.equal(fetched, 0);
});

// ─── injected authoritative provider catalog ───────────────────────────────
//
// The daemon builds `createBuiltinCatalog([codeBuddy])` from a real CodeBuddy
// install and injects it as `resolveProvider`. The default built-in CodeBuddy
// definition offers no models at all, so these cases pin that an injected
// catalog is honoured, that it is authoritative (never falling back to the
// static definitions), and that auxiliary requests never consult it.

/**
 * A real CodeBuddy provider offering two fixture wire models, in a builtin
 * catalog, exposed as the host-style `resolveProvider` callback.
 */
function injectedCatalog(): (id: string) => ProviderDefinition | undefined {
  const provider = createCodeBuddy({ productModels: [{ id: 'kimi-k3' }, { id: 'claude-opus-5.5' }] });
  const catalog = createBuiltinCatalog([provider]);
  return (id: string) => catalog.provider(id);
}

test('an injected product catalogue lets a main request reach the chat driver', async () => {
  const gateway = { calls: 0 };
  const capture: Capture = {};
  const driver = createInferenceDriver(fakeGateway(gateway), {
    fetch: fakeFetch(jsonResponse({ choices: [{ message: { content: 'injected answer' } }] }), capture),
    resolveProvider: injectedCatalog(),
  });

  // The standalone default catalog offers no CodeBuddy model, so this only
  // passes because the injected catalog is consulted for main validation.
  const result = await driver.complete(baseRequest({ model: 'codebuddy/kimi-k3', actionTool: true }));

  assert.equal(gateway.calls, 1);
  assert.equal(capture.url, 'http://gateway.test/v1/chat/completions');
  assert.equal(result.text, 'injected answer');
});

test('an injected alias wire id validates against the injected catalogue', async () => {
  const gateway = { calls: 0 };
  const capture: Capture = {};
  const driver = createInferenceDriver(fakeGateway(gateway), {
    fetch: fakeFetch(jsonResponse({ choices: [{ message: { content: 'aliased answer' } }] }), capture),
    resolveProvider: injectedCatalog(),
  });

  // `claude-opus-5.5` is the fixture wire spelling; the offered identity is
  // `claude-opus-5-5`, so this resolves only through the injected alias map.
  const result = await driver.complete(baseRequest({ model: 'codebuddy/claude-opus-5.5', actionTool: true }));

  assert.equal(gateway.calls, 1);
  assert.equal(capture.url, 'http://gateway.test/v1/chat/completions');
  assert.equal(result.text, 'aliased answer');
});

test('unknown, unavailable and retired injected models fail before any call', async () => {
  const resolveProvider = injectedCatalog();
  const cases: readonly { model: string; pattern: RegExp }[] = [
    { model: 'not-a-provider/kimi-k3', pattern: /Unknown inference provider/u },
    { model: 'codebuddy/does-not-exist', pattern: /Unknown inference model/u },
    // The injected catalog is authoritative: a model the standalone CodeBuddy
    // definition would not offer either is still unknown here.
    { model: 'codebuddy/deepseek-v4.1-flash', pattern: /Unknown inference model/u },
    // Retired Claude generation-5 stays withheld and rejected.
    { model: 'codebuddy/claude-opus-5', pattern: /Unknown inference model/u },
  ];

  for (const { model, pattern } of cases) {
    const gateway = { calls: 0 };
    let fetched = 0;
    const driver = createInferenceDriver(fakeGateway(gateway), {
      fetch: (async () => { fetched += 1; return jsonResponse({}); }) as typeof fetch,
      resolveProvider,
    });

    await assert.rejects(driver.complete(baseRequest({ model, actionTool: true })), pattern);
    assert.equal(gateway.calls, 0, `gateway was acquired for ${model}`);
    assert.equal(fetched, 0, `fetch was called for ${model}`);
  }
});

function sseResponse(frames: readonly unknown[]): Response {
  const body = [...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`), 'data: [DONE]\n\n'].join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

test('a reply-tool request declares only the reply tool and returns each streamed reply text', async () => {
  const capture: Capture = {};
  const driver = createInferenceDriver(fakeGateway({ calls: 0 }), {
    resolveProvider: builtinProvider,
    fetch: fakeFetch(sseResponse([
      { choices: [{ delta: { content: 'ignored prose' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'reply', arguments: '{"text":"第一' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '句"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { name: 'reply', arguments: '{"text":"- 第二条"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]), capture),
  });

  const result = await driver.complete(baseRequest({ model: 'codebuddy/kimi-k3', replyTool: true }));

  const body = JSON.parse(String(capture.init?.body)) as { tools: { function: { name: string } }[] };
  assert.deepEqual(body.tools.map((tool) => tool.function.name), ['reply']);
  assert.deepEqual(result.replies, ['第一句', '- 第二条']);
  assert.deepEqual(result.toolCalls, [], 'reply calls are never reported as actions');
  assert.equal(result.text, 'ignored prose');
});

test('a reply-tool request without a tool call returns no replies', async () => {
  const driver = createInferenceDriver(fakeGateway({ calls: 0 }), {
    resolveProvider: builtinProvider,
    fetch: fakeFetch(jsonResponse({ choices: [{ message: { content: '' } }] })),
  });
  const result = await driver.complete(baseRequest({ model: 'codebuddy/kimi-k3', replyTool: true }));
  assert.equal(result.replies, undefined);
});

test('a malformed reply call fails the request', async () => {
  const driver = createInferenceDriver(fakeGateway({ calls: 0 }), {
    resolveProvider: builtinProvider,
    fetch: fakeFetch(jsonResponse({
      choices: [{ message: { content: null, tool_calls: [{ function: { name: 'reply', arguments: '{"txt":1}' } }] } }],
    })),
  });
  await assert.rejects(
    driver.complete(baseRequest({ model: 'codebuddy/kimi-k3', replyTool: true })),
    /invalid reply call/u,
  );
});

test('auxiliary requests bypass the injected resolver entirely', async () => {
  const gateway = { calls: 0 };
  const capture: Capture = {};
  let resolved = 0;
  const driver = createInferenceDriver(fakeGateway(gateway), {
    fetch: fakeFetch(jsonResponse({ choices: [{ message: { content: 'aux answer' } }] }), capture),
    // A resolver that must never be consulted for an auxiliary request.
    resolveProvider: () => { resolved += 1; return undefined; },
  });

  // No `actionTool`: the model is a gateway public id and needs no provider.
  const result = await driver.complete(baseRequest({ model: 'codebuddy/kimi-k3' }));

  assert.equal(resolved, 0);
  assert.equal(gateway.calls, 1);
  assert.equal(result.text, 'aux answer');
});
