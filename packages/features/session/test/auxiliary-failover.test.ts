import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ReasoningEffort } from '@wrenyard/models';
import type { ProviderDefinition } from '@wrenyard/providers/base';
import {
  AUXILIARY_IDLE_TIMEOUT_MS,
  AUXILIARY_MAX_ROUTES,
  AUXILIARY_TOTAL_BUDGET_MS,
  createCallRunner,
  ModelCallError,
  type CallRole,
  type ModelCallInput,
  type RouteHealth,
  type SpanEventDraft,
} from '../src/model/request.ts';
import { ROLE_REQUIREMENTS } from '../src/model/roles.ts';
import { ModelError, type ModelResult, type ModelRequest, type ModelTransport } from '../src/transport/index.ts';

const MODEL_IDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
const providerStub = {
  id: 'test',
  models: MODEL_IDS.map((id) => ({ id, reasoningEfforts: ['none', 'low', 'medium', 'high'] })),
} as unknown as ProviderDefinition;

/** Let the runner reach its in-flight await before a test drives its timing. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A transport failure shaped exactly like the real one — the normalized error
 * carries the single attempt the transport issued, so the runner records it.
 */
const transportFault = (request: ModelRequest, kind: 'network' | 'server' = 'network'): ModelError =>
  new ModelError(`fault:${request.model}`, {
    kind,
    metrics: { attempts: [{ error: kind, ms: 5, model: request.model }] },
  });

function makeRunner(options: {
  transport: ModelTransport;
  routes: readonly string[];
  routeStatus?: (model: string) => RouteHealth | undefined;
  reportRouteFault?: (model: string, attemptId: string, kind: 'timeout' | 'transport') => void;
  beginRouteAttempt?: (model: string, attemptId: string) => void;
  completeRouteAttempt?: (model: string, attemptId: string) => void;
}) {
  const events: SpanEventDraft[] = [];
  const runner = createCallRunner({
    resolveProvider: () => providerStub,
    transport: options.transport,
    ...(options.routeStatus === undefined ? {} : { routeStatus: options.routeStatus }),
    ...(options.reportRouteFault === undefined ? {} : { reportRouteFault: options.reportRouteFault }),
    ...(options.beginRouteAttempt === undefined ? {} : { beginRouteAttempt: options.beginRouteAttempt }),
    ...(options.completeRouteAttempt === undefined ? {} : { completeRouteAttempt: options.completeRouteAttempt }),
    selectAuxiliary: (role) => options.routes.map((model) => ({
      model,
      reasoningEffort: ROLE_REQUIREMENTS[role].expectedReasoningEffort[0] as ReasoningEffort,
    })),
    append: (event) => { events.push(event); },
    now: () => new Date(),
  });
  return { runner, events };
}

function callInput(role: CallRole, signal: AbortSignal): ModelCallInput {
  return { spanId: 'span-1', parent: 'action-1', role, messages: [{ role: 'user', content: 'hi' }], layers: {}, signal };
}

const succeeded = (model: string): ModelResult => ({ text: `ok:${model}`, toolCalls: [], metrics: { attempts: [{ status: 200, ms: 1 }] } });

test('a failed auxiliary route fails over to the next distinct route within budget', async () => {
  const calls: string[] = [];
  const transport: ModelTransport = {
    async complete(request: ModelRequest) {
      calls.push(request.model);
      if (request.model === 'test/alpha') throw new ModelError('hung', { kind: 'network' });
      return succeeded(request.model);
    },
  };
  const { runner, events } = makeRunner({ transport, routes: ['test/alpha', 'test/beta', 'test/gamma', 'test/delta'] });
  const output = await runner.run(callInput('reply', new AbortController().signal));
  assert.equal(output.model, 'test/beta');
  // One attempt per route: the auxiliary path performs no same-route retry.
  assert.deepEqual(calls, ['test/alpha', 'test/beta']);
  const started = events[0] as { type: string; request?: { route?: { candidates: unknown[] } } };
  assert.equal(started.type, 'span.started');
  // The recorded candidate list is the full ranked set, never pre-truncated.
  assert.equal(started.request?.route?.candidates.length, 4);
});

test('at most three distinct routes are tried, each exactly once', async () => {
  const calls: string[] = [];
  const transport: ModelTransport = {
    async complete(request: ModelRequest) {
      calls.push(request.model);
      throw new ModelError('down', { kind: 'server' });
    },
  };
  const { runner } = makeRunner({ transport, routes: ['test/alpha', 'test/beta', 'test/gamma', 'test/delta', 'test/epsilon'] });
  await assert.rejects(runner.run(callInput('reply', new AbortController().signal)));
  assert.equal(calls.length, AUXILIARY_MAX_ROUTES);
  assert.equal(new Set(calls).size, calls.length);
});

test('no failover once visible output has begun', async () => {
  const calls: string[] = [];
  const transport: ModelTransport = {
    async complete(request: ModelRequest) {
      calls.push(request.model);
      if (request.model === 'test/alpha') {
        request.onEvent?.({ type: 'text', delta: 'partial' });
        throw new ModelError('broke mid-stream', { kind: 'network' });
      }
      return succeeded(request.model);
    },
  };
  const { runner } = makeRunner({ transport, routes: ['test/alpha', 'test/beta'] });
  await assert.rejects(runner.run(callInput('reply', new AbortController().signal)));
  assert.deepEqual(calls, ['test/alpha']);
});

test('no failover on a user cancellation', async () => {
  const calls: string[] = [];
  const transport: ModelTransport = {
    async complete(request: ModelRequest) {
      calls.push(request.model);
      return succeeded(request.model);
    },
  };
  const { runner } = makeRunner({ transport, routes: ['test/alpha', 'test/beta'] });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runner.run(callInput('reply', controller.signal)));
  assert.deepEqual(calls, []);
});

test('no failover on an invalid-request failure', async () => {
  const calls: string[] = [];
  const transport: ModelTransport = {
    async complete(request: ModelRequest) {
      calls.push(request.model);
      if (request.model === 'test/alpha') throw new ModelError('bad request', { kind: 'invalid_request' });
      return succeeded(request.model);
    },
  };
  const { runner } = makeRunner({ transport, routes: ['test/alpha', 'test/beta'] });
  await assert.rejects(runner.run(callInput('reply', new AbortController().signal)));
  assert.deepEqual(calls, ['test/alpha']);
});

test('exhaustion reports the attempt count and the bounded budget', async () => {
  const transport: ModelTransport = {
    async complete() { throw new ModelError('down', { kind: 'network' }); },
  };
  const { runner } = makeRunner({ transport, routes: ['test/alpha', 'test/beta', 'test/gamma'] });
  await assert.rejects(runner.run(callInput('reply', new AbortController().signal)), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /3 of 3 candidate route\(s\), budget 60000 ms/);
    return true;
  });
});

test('all routes cooling down returns promptly with the earliest retry and calls no open route', async () => {
  const calls: string[] = [];
  const until = '2026-01-01T00:05:00.000Z';
  const transport: ModelTransport = {
    async complete(request: ModelRequest) {
      calls.push(request.model);
      return succeeded(request.model);
    },
  };
  const { runner } = makeRunner({
    transport,
    routes: ['test/alpha', 'test/beta'],
    routeStatus: () => ({ state: 'model_unavailable', until, phase: 'open' }),
  });
  await assert.rejects(runner.run(callInput('reply', new AbortController().signal)), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /every candidate route is cooling down or probing/);
    assert.match(error.message, new RegExp(until));
    return true;
  });
  // The known-open first route is never reused.
  assert.deepEqual(calls, []);
});

test('a half-open preferred route is tried so it can recover', async () => {
  const calls: string[] = [];
  const transport: ModelTransport = {
    async complete(request: ModelRequest) {
      calls.push(request.model);
      return succeeded(request.model);
    },
  };
  const { runner } = makeRunner({
    transport,
    routes: ['test/alpha', 'test/beta'],
    routeStatus: (model) => (model === 'test/alpha'
      ? { state: 'model_unavailable', until: '2026-01-01T00:00:00.000Z', phase: 'half_open' }
      : undefined),
  });
  const output = await runner.run(callInput('reply', new AbortController().signal));
  assert.equal(output.model, 'test/alpha');
  assert.deepEqual(calls, ['test/alpha']);
});

test('a route whose probe another caller holds is skipped until nextProbeAt', async () => {
  const calls: string[] = [];
  const nextProbeAt = '2999-01-01T00:00:00.000Z';
  const transport: ModelTransport = {
    async complete(request: ModelRequest) {
      calls.push(request.model);
      return succeeded(request.model);
    },
  };
  const { runner } = makeRunner({
    transport,
    routes: ['test/alpha', 'test/beta'],
    // A probe-eligible route another caller is already probing: the circuit is
    // half-open but the next admission is in the future.
    routeStatus: (model) => (model === 'test/alpha'
      ? { state: 'model_unavailable', until: nextProbeAt, phase: 'half_open', nextProbeAt }
      : undefined),
  });
  const output = await runner.run(callInput('reply', new AbortController().signal));
  assert.equal(output.model, 'test/beta');
  assert.deepEqual(calls, ['test/beta']);
});

test('all routes faulting retains per-attempt metrics and retryAt with the last failure kind', async () => {
  const until = '2026-01-01T00:05:00.000Z';
  const transport: ModelTransport = {
    async complete(request: ModelRequest) { throw transportFault(request); },
  };
  const { runner } = makeRunner({
    transport,
    routes: ['test/alpha', 'test/beta'],
    routeStatus: () => ({ state: 'model_unavailable', until, phase: 'half_open' }),
  });
  await assert.rejects(runner.run(callInput('reply', new AbortController().signal)), (error: unknown) => {
    assert.ok(error instanceof ModelCallError);
    // The kind is the last real failure, never the generic `protocol` default.
    assert.equal(error.detail.failure?.kind, 'network');
    // The retry instant of the failed routes survives to the caller.
    assert.equal(error.detail.failure?.retryAt, until);
    const attempts = error.detail.metrics?.attempts ?? [];
    // One record per attempted route, each with its own model and retry time.
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map((attempt) => attempt.model), ['test/alpha', 'test/beta']);
    assert.ok(attempts.every((attempt) => attempt.routeUntil === until));
    return true;
  });
});

test('a real failure after partial output is reported to the route health without failing over', async () => {
  const calls: string[] = [];
  const faults: Array<{ model: string; kind: string }> = [];
  const transport: ModelTransport = {
    async complete(request: ModelRequest) {
      calls.push(request.model);
      request.onEvent?.({ type: 'text', delta: 'partial' });
      throw transportFault(request);
    },
  };
  const { runner } = makeRunner({
    transport,
    routes: ['test/alpha', 'test/beta'],
    reportRouteFault: (model, _attemptId, kind) => { faults.push({ model, kind }); },
  });
  await assert.rejects(runner.run(callInput('reply', new AbortController().signal)));
  // Visible output already began: the fault is reported but nothing fails over.
  assert.deepEqual(calls, ['test/alpha']);
  assert.deepEqual(faults, [{ model: 'test/alpha', kind: 'transport' }]);
});

test('a real transport failure is reported to the route health before failing over', async () => {
  const faults: Array<{ model: string; kind: string }> = [];
  const transport: ModelTransport = {
    async complete(request: ModelRequest) {
      if (request.model === 'test/alpha') throw transportFault(request);
      return succeeded(request.model);
    },
  };
  const { runner } = makeRunner({
    transport,
    routes: ['test/alpha', 'test/beta'],
    reportRouteFault: (model, _attemptId, kind) => { faults.push({ model, kind }); },
  });
  const output = await runner.run(callInput('reply', new AbortController().signal));
  assert.equal(output.model, 'test/beta');
  assert.deepEqual(faults, [{ model: 'test/alpha', kind: 'transport' }]);
});

test('the finite total budget cuts the call without blaming the route', async () => {
  const faults: string[] = [];
  // A route that keeps streaming progress never trips the idle deadline, so
  // only the caller's finite total budget can end this call.
  const transport: ModelTransport = {
    complete: (request) => {
      const progress = setInterval(() => request.onEvent?.({ type: 'activity' }), 7000);
      request.signal.addEventListener('abort', () => clearInterval(progress), { once: true });
      return new Promise<ModelResult>(() => {});
    },
  };
  const { runner } = makeRunner({
    transport,
    routes: ['test/alpha'],
    reportRouteFault: (_model, _attemptId, kind) => { faults.push(kind); },
  });
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let error: unknown;
  try {
    const pending = runner.run(callInput('reply', new AbortController().signal))
      .then(() => undefined, (failure: unknown) => failure);
    await flush();
    mock.timers.tick(AUXILIARY_TOTAL_BUDGET_MS);
    await flush();
    error = await pending;
  } finally {
    mock.timers.reset();
  }
  assert.ok(error instanceof ModelCallError);
  // The caller's own budget is a local deadline, not the route's fault.
  assert.match(error.message, /Call timed out after 60000 ms/);
  assert.deepEqual(faults, []);
  // No synthesized attempt record is attributed to the route either.
  assert.equal((error.detail.metrics?.attempts ?? []).length, 0);
});

test('a silent route idle-stalls once, reports one timeout fault, and fails over', async () => {
  const calls: string[] = [];
  const faults: Array<{ model: string; kind: string }> = [];
  const transport: ModelTransport = {
    complete: (request) => {
      calls.push(request.model);
      if (request.model === 'test/alpha') return new Promise<ModelResult>(() => {});
      return Promise.resolve(succeeded(request.model));
    },
  };
  const { runner } = makeRunner({
    transport,
    routes: ['test/alpha', 'test/beta'],
    reportRouteFault: (model, _attemptId, kind) => { faults.push({ model, kind }); },
  });
  mock.timers.enable({ apis: ['setTimeout'] });
  let output: ModelResult | undefined;
  try {
    const pending = runner.run(callInput('reply', new AbortController().signal));
    await flush();
    // No output for the whole idle deadline is the one thing that may be
    // reported as a route timeout.
    mock.timers.tick(AUXILIARY_IDLE_TIMEOUT_MS);
    await flush();
    output = await pending;
  } finally {
    mock.timers.reset();
  }
  // Only the failover route resolved, so the result is the beta transport's response.
  assert.equal(output?.text, 'ok:test/beta');
  assert.deepEqual(calls, ['test/alpha', 'test/beta']);
  assert.deepEqual(faults, [{ model: 'test/alpha', kind: 'timeout' }]);
});

test('no auxiliary request carries a local deadline for a transport to blame', async () => {
  const requests: ModelRequest[] = [];
  const transport: ModelTransport = {
    async complete(request) {
      requests.push(request);
      return succeeded(request.model);
    },
  };
  const { runner } = makeRunner({ transport, routes: ['test/alpha', 'test/beta'] });
  await runner.run(callInput('reply', new AbortController().signal));
  assert.ok(requests.length >= 1);
  assert.ok(requests.every((request) => request.deadlineAtMs === undefined));
});

test('an explicit user cancellation stays neutral and reports no route fault', async () => {
  const faults: string[] = [];
  let inFlight: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { inFlight = resolve; });
  const transport: ModelTransport = {
    complete: (request) => new Promise<ModelResult>((_resolve, reject) => {
      inFlight?.();
      request.signal.addEventListener('abort', () => reject(transportFault(request, 'server')), { once: true });
    }),
  };
  const controller = new AbortController();
  const { runner } = makeRunner({
    transport,
    routes: ['test/alpha', 'test/beta'],
    reportRouteFault: (_model, _attemptId, kind) => { faults.push(kind); },
  });
  const pending = runner.run(callInput('reply', controller.signal));
  await started;
  await flush();
  controller.abort();
  await assert.rejects(pending);
  assert.deepEqual(faults, []);
});

test('a cancellation between the span.started append and the loop finishes as aborted', async () => {
  const controller = new AbortController();
  const transport: ModelTransport = {
    async complete() { throw new Error('the transport must not be called'); },
  };
  const events: SpanEventDraft[] = [];
  const runner = createCallRunner({
    resolveProvider: () => providerStub,
    transport,
    selectAuxiliary: (role) => ['test/alpha', 'test/beta'].map((model) => ({
      model,
      reasoningEffort: ROLE_REQUIREMENTS[role].expectedReasoningEffort[0] as ReasoningEffort,
    })),
    append: (event) => {
      events.push(event);
      // Cancel in the middle of the awaited append, before the loop runs.
      if (event.type === 'span.started') controller.abort();
    },
    now: () => new Date(),
  });
  await assert.rejects(runner.run(callInput('reply', controller.signal)), (error: unknown) => {
    assert.ok(error instanceof ModelCallError);
    assert.equal(error.detail.status, 'aborted');
    // The pre-loop cancellation is terminal `aborted` with the plain abort
    // message and carries no structured route-failure fact.
    assert.equal(error.message, 'Model call was aborted');
    return true;
  });
  assert.equal(events.filter((event) => event.type === 'span.finished').length, 1);
});

test('a timed-out attempt is recorded exactly once', async () => {
  const transport: ModelTransport = { complete: () => new Promise<ModelResult>(() => {}) };
  const { runner } = makeRunner({ transport, routes: ['test/alpha'] });
  mock.timers.enable({ apis: ['setTimeout'] });
  let error: unknown;
  try {
    const pending = runner.run(callInput('reply', new AbortController().signal));
    await flush();
    mock.timers.tick(AUXILIARY_IDLE_TIMEOUT_MS);
    error = await pending.then(() => undefined, (failure: unknown) => failure);
  } finally {
    mock.timers.reset();
  }
  assert.ok(error instanceof ModelCallError);
  const attempts = error.detail.metrics?.attempts ?? [];
  // Only the synthesized timeout record: the aborted transport metric is not
  // counted a second time.
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.model, 'test/alpha');
  assert.equal(attempts[0]?.error, 'network');
});
