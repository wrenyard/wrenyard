/**
 * Focused offline tests for the OpenAI Responses inference adapter.
 *
 * Every case uses an injected fake `fetch` that returns an in-memory `Response`
 * or a hand-fed `ReadableStream`; no model, network or E2E call is made. The
 * tests cover standard request mapping (image, effort, no history/store), the
 * streamed action lifecycle (reported before completion, exactly once), usage,
 * malformed frames, unknown tools, incomplete/truncated streams, abort cleanup
 * and split frames.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { WrenyardGatewayConnection } from '@wrenyard/control-client';
import { ACTION_TOOL, type DriverRequest, type ToolCall, type Usage } from '../src/driver.ts';
import { createResponsesDriver, serializeResponsesRequest } from '../src/responses-driver.ts';

const CONNECTION: WrenyardGatewayConnection = {
  openaiChatBaseUrl: 'http://gateway.test/v1',
  openaiResponsesBaseUrl: 'http://gateway.test/v1',
  anthropicBaseUrl: 'http://gateway.test',
  token: 'test-token',
  models: [],
};

const encoder = new TextEncoder();

function baseRequest(overrides: Partial<DriverRequest> = {}): DriverRequest {
  return {
    model: 'vendor/model',
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

function fakeFetch(response: Response, capture: Capture = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url);
    capture.init = init;
    return response;
  }) as typeof fetch;
}

function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function streamResponse(chunks: readonly string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

test('serializeResponsesRequest maps one system and one user message, image and effort', () => {
  const body = JSON.parse(serializeResponsesRequest({
    model: 'vendor/model',
    messages: [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
    reasoningEffort: 'high',
    maxTokens: 4096,
    actionTool: true,
  })) as Record<string, unknown>;

  assert.equal(body.model, 'vendor/model');
  assert.equal(body.instructions, 'sys');
  assert.deepEqual(body.input, [{
    role: 'user',
    content: [
      { type: 'input_text', text: 'look' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ],
  }]);
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal('previous_response_id' in body, false);
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
  assert.equal(body.max_output_tokens, 4096);
  assert.deepEqual(body.tools, [{
    type: 'function',
    name: ACTION_TOOL.function.name,
    description: ACTION_TOOL.function.description,
    parameters: ACTION_TOOL.function.parameters,
  }]);
});

test('serializeResponsesRequest omits optional fields and sends a trailing closing message as developer', () => {
  const body = JSON.parse(serializeResponsesRequest({
    model: 'vendor/model',
    messages: [{ role: 'user', content: 'plain' }],
  })) as Record<string, unknown>;
  assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'plain' }] }]);
  assert.equal('instructions' in body, false);
  assert.deepEqual(body.reasoning, { summary: 'auto' });
  assert.equal('max_output_tokens' in body, false);
  assert.equal('tools' in body, false);

  const appended = JSON.parse(serializeResponsesRequest({
    model: 'vendor/model',
    messages: [{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }],
    cacheKey: 'session-1',
  })) as Record<string, unknown>;
  assert.deepEqual(appended.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'one' }] },
    { role: 'developer', content: [{ type: 'input_text', text: 'two' }] },
  ]);
  assert.equal(appended.prompt_cache_key, 'session-1');
  assert.throws(() => serializeResponsesRequest({
    model: 'vendor/model',
    messages: [
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
      { role: 'user', content: 'one' },
    ],
  }), /at most one system message/u);
});

test('streams text, reasoning and usage and finishes on response.completed', async () => {
  const capture: Capture = {};
  const usage = {
    input_tokens: 10,
    output_tokens: 4,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 3 },
  };
  const driver = createResponsesDriver(CONNECTION, {
    fetch: fakeFetch(streamResponse([
      frame('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, delta: 'Hel' }),
      frame('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, delta: 'lo' }),
      frame('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'think' }),
      frame('response.completed', { type: 'response.completed', response: { status: 'completed', usage } }),
    ]), capture),
  });

  const text: string[] = [];
  const reasoning: string[] = [];
  const usages: Usage[] = [];
  const result = await driver.complete(baseRequest({
    onText: (delta) => text.push(delta),
    onReasoning: (delta) => reasoning.push(delta),
    onUsage: (value) => usages.push(value),
  }));

  assert.equal(capture.url, 'http://gateway.test/v1/responses');
  assert.equal(result.text, 'Hello');
  assert.equal(result.reasoning, 'think');
  assert.deepEqual(result.usage, { input: 10, output: 4, cachedInput: 2, reasoning: 3 });
  assert.deepEqual(text, ['Hel', 'lo']);
  assert.deepEqual(reasoning, ['think']);
  assert.deepEqual(usages, [{ input: 10, output: 4, cachedInput: 2, reasoning: 3 }]);
});

test('reports every action before completion, exactly once and in index order', async () => {
  const firstArguments = JSON.stringify({ type: 'read', intent: 'read the doc' });
  const secondArguments = JSON.stringify({ type: 'dispatch', intent: 'dispatch work' });
  const calls: ToolCall[] = [];
  let callsAtCompletion = -1;

  const driver = createResponsesDriver(CONNECTION, {
    fetch: fakeFetch(streamResponse([
      frame('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_0', call_id: 'c0', name: 'wy_action', arguments: '' },
      }),
      frame('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_0',
        output_index: 0,
        delta: firstArguments.slice(0, 8),
      }),
      frame('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_0',
        output_index: 0,
        delta: firstArguments.slice(8),
      }),
      frame('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'wy_action', arguments: '' },
      }),
      frame('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 1,
        delta: secondArguments,
      }),
      // Done frames arrive out of index order; reporting must still be exact.
      frame('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'wy_action', arguments: secondArguments },
      }),
      frame('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_0', call_id: 'c0', name: 'wy_action', arguments: firstArguments },
      }),
      frame('response.completed', {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 1 } },
      }),
    ])),
  });

  const result = await driver.complete(baseRequest({
    actionTool: true,
    onToolCall: (call) => calls.push(call),
    onUsage: () => { callsAtCompletion = calls.length; },
  }));

  // Both action callbacks fired before the terminal event was consumed.
  assert.equal(callsAtCompletion, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(result.toolCalls, [
    { index: 0, type: 'read', intent: 'read the doc' },
    { index: 1, type: 'dispatch', intent: 'dispatch work' },
  ]);
});

test('reports an unknown tool name as an invalid call', async () => {
  const args = JSON.stringify({ type: 'read', intent: 'x' });
  const driver = createResponsesDriver(CONNECTION, {
    fetch: fakeFetch(streamResponse([
      frame('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_0', name: 'other_tool', arguments: '' },
      }),
      frame('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_0',
        output_index: 0,
        delta: args,
      }),
      frame('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_0', name: 'other_tool', arguments: args },
      }),
      frame('response.completed', { type: 'response.completed', response: { status: 'completed' } }),
    ])),
  });

  const result = await driver.complete(baseRequest({ actionTool: true }));
  assert.equal(result.toolCalls?.length, 1);
  assert.match(result.toolCalls?.[0]?.error ?? '', /unknown tool/u);
});

test('fails on malformed stream data', async () => {
  const driver = createResponsesDriver(CONNECTION, {
    fetch: fakeFetch(streamResponse(['data: not-json\n\n'])),
  });
  await assert.rejects(driver.complete(baseRequest()), /invalid data/u);
});

test('fails on a truncated stream before response.completed', async () => {
  const driver = createResponsesDriver(CONNECTION, {
    fetch: fakeFetch(streamResponse([
      frame('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, delta: 'partial' }),
    ])),
  });
  await assert.rejects(driver.complete(baseRequest()), /before the reply was complete/u);
});

test('fails on response.incomplete and preserves the reported usage', async () => {
  const usages: Usage[] = [];
  const driver = createResponsesDriver(CONNECTION, {
    fetch: fakeFetch(streamResponse([
      frame('response.incomplete', {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 5 },
        },
      }),
    ])),
  });
  await assert.rejects(driver.complete(baseRequest({ onUsage: (value) => usages.push(value) })), /incomplete/u);
  assert.deepEqual(usages, [{ input: 5 }]);
});

test('does not issue a request when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const driver = createResponsesDriver(CONNECTION, {
    fetch: (async () => { called = true; return streamResponse([]); }) as typeof fetch,
  });
  await assert.rejects(
    driver.complete(baseRequest({ signal: controller.signal })),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
  assert.equal(called, false);
});

test('cancels the reader when aborted mid-stream', async () => {
  const controller = new AbortController();
  let cancelled = false;
  let flow!: ReadableStreamDefaultController<Uint8Array>;
  let releaseText!: () => void;
  const sawText = new Promise<void>((resolve) => { releaseText = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    start(inner) { flow = inner; },
    cancel() { cancelled = true; },
  });
  const driver = createResponsesDriver(CONNECTION, {
    fetch: (async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch,
  });

  const completion = driver.complete(baseRequest({
    signal: controller.signal,
    onText: () => releaseText(),
  }));
  flow.enqueue(encoder.encode(frame('response.output_text.delta', {
    type: 'response.output_text.delta',
    output_index: 0,
    delta: 'x',
  })));
  await sawText;
  controller.abort();
  await assert.rejects(completion, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(cancelled, true);
});

test('reassembles split frames, CRLF and multiline data fields', async () => {
  const first = frame('response.output_text.delta', {
    type: 'response.output_text.delta',
    output_index: 0,
    delta: 'split',
  }).replace(/\n/gu, '\r\n');
  const second = frame('response.completed', {
    type: 'response.completed',
    status: 'completed',
    response: { status: 'completed' },
  }).replace(/\n/gu, '\r\n');
  const cutoff = Math.floor(first.length / 2);
  const multilineJson = JSON.stringify({
    type: 'response.reasoning_summary_text.delta',
    output_index: 0,
    delta: 'multi',
  }, null, 2);
  const multiline = `${multilineJson.split('\n').map((line) => `data: ${line}`).join('\n')}\n\n`;
  const driver = createResponsesDriver(CONNECTION, {
    fetch: fakeFetch(streamResponse([first.slice(0, cutoff), first.slice(cutoff), multiline, second])),
  });

  const result = await driver.complete(baseRequest());
  assert.equal(result.text, 'split');
  assert.equal(result.reasoning, 'multi');
});

test('reads a non-streaming JSON response with message, reasoning and function call', async () => {
  const payload = {
    id: 'resp_1',
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
      {
        type: 'function_call',
        id: 'fc_0',
        name: 'wy_action',
        arguments: JSON.stringify({ type: 'ask', intent: 'question' }),
      },
    ],
    usage: { input_tokens: 3, output_tokens: 1 },
  };
  const driver = createResponsesDriver(CONNECTION, {
    fetch: fakeFetch(new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })),
  });

  const reasoning: string[] = [];
  const result = await driver.complete(baseRequest({
    actionTool: true,
    onReasoning: (delta) => reasoning.push(delta),
  }));
  assert.equal(result.text, 'answer');
  assert.equal(result.reasoning, 'thought');
  assert.deepEqual(reasoning, ['thought']);
  assert.deepEqual(result.toolCalls, [{ index: 2, type: 'ask', intent: 'question' }]);
  assert.deepEqual(result.usage, { input: 3, output: 1 });
});

test('surfaces an upstream non-2xx body as an error', async () => {
  const driver = createResponsesDriver(CONNECTION, {
    fetch: fakeFetch(new Response('upstream exploded', { status: 502 })),
  });
  await assert.rejects(driver.complete(baseRequest()), /Model request failed \(HTTP 502\): upstream exploded/u);
});
