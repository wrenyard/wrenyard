import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Catalog } from '@wrenyard/providers/catalog';
import type { ProviderRuntime } from '@wrenyard/providers';
import type { ProviderDefinition } from '@wrenyard/providers/base';
import { RouteStateStore, type RouteStateChangedEvent } from '../src/route-state.ts';
import { classifyRouteFailure, classifyStreamFailure, transportFailure } from '../src/route-failure.ts';
import { createModelGateway } from '../src/index.ts';

/** A fake clock; every test advances it explicitly so nothing waits on wall time. */
function fakeClock(start = Date.parse('2026-01-01T00:00:00.000Z')) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
    set: (ms: number) => { now = ms; },
  };
}

/** A store whose pools are empty, so an unnamed pool fault binds the route. */
function makeStore(clock: () => number, events: RouteStateChangedEvent[] = []): RouteStateStore {
  return new RouteStateStore(clock, () => [], (event) => events.push(event));
}

const provider = {} as unknown as ProviderDefinition;

test('a route fault is isolated to its exact provider/model', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm1', transportFailure(), 502, '');
  assert.equal(store.status('p', 'm1')?.phase, 'open');
  assert.equal(store.status('p', 'm1')?.faultKind, 'transport');
  // A sibling model of the same provider is untouched by a route-scoped fault.
  assert.equal(store.status('p', 'm2'), undefined);
  assert.equal(store.status('other', 'm1'), undefined);
});

test('a validated success restores health; a stale success cannot overwrite a newer fault', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm', transportFailure(), 502, '');
  const guard = store.capture('p', 'm');
  // A newer fault generation replaces the one this call observed.
  store.mark('p', 'm', transportFailure(), 502, '');
  store.success('p', 'm', guard);
  // The stale success must not clear the newer fault.
  assert.ok(store.status('p', 'm'));
  // A success at the current generation clears it.
  store.success('p', 'm', store.capture('p', 'm'));
  assert.equal(store.status('p', 'm'), undefined);
});

test('a success on one model never clears another model’s route fault', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm1', transportFailure(), 502, '');
  store.mark('p', 'm2', transportFailure(), 502, '');
  store.success('p', 'm1', store.capture('p', 'm1'));
  assert.equal(store.status('p', 'm1'), undefined);
  assert.ok(store.status('p', 'm2'));
});

test('every HTTP outcome is classified: transport faults are route-scoped, auth provider, rate limit pool', () => {
  const headers = new Headers();
  assert.equal(classifyRouteFailure(provider, 'm', 500, headers, undefined, 0)?.faultKind, 'server_error');
  assert.equal(classifyRouteFailure(provider, 'm', 500, headers, undefined, 0)?.scope, 'route');
  assert.equal(classifyRouteFailure(provider, 'm', 408, headers, undefined, 0)?.faultKind, 'timeout');
  assert.equal(classifyRouteFailure(provider, 'm', 408, headers, undefined, 0)?.scope, 'route');
  assert.equal(classifyRouteFailure(provider, 'm', 401, headers, undefined, 0)?.faultKind, 'auth_failed');
  assert.equal(classifyRouteFailure(provider, 'm', 401, headers, undefined, 0)?.scope, 'provider');
  assert.equal(classifyRouteFailure(provider, 'm', 403, headers, undefined, 0)?.scope, 'provider');
  assert.equal(classifyRouteFailure(provider, 'm', 402, headers, undefined, 0)?.scope, 'pool');
  assert.equal(classifyRouteFailure(provider, 'm', 429, headers, undefined, 0)?.scope, 'pool');
  assert.equal(classifyRouteFailure(provider, 'm', 404, headers, undefined, 0)?.scope, 'route');
  assert.equal(transportFailure().faultKind, 'transport');
});

test('request-invalid and context-overflow errors are reported but never poison a route', () => {
  const headers = new Headers();
  assert.equal(classifyRouteFailure(provider, 'm', 400, headers, { error: { code: 'bad_field' } }, 0), undefined);
  assert.equal(classifyRouteFailure(provider, 'm', 422, headers, {}, 0), undefined);
  assert.equal(classifyRouteFailure(provider, 'm', 400, headers, { error: { code: 'context_length_exceeded' } }, 0), undefined);
});

test('in-stream error frames classify into the same scopes as HTTP errors', () => {
  assert.equal(classifyStreamFailure({ type: 'server_error', code: 'overloaded_error' })?.scope, 'route');
  assert.equal(classifyStreamFailure({ code: 'rate_limit_exceeded' })?.scope, 'pool');
  assert.equal(classifyStreamFailure({ type: 'authentication_error' })?.scope, 'provider');
  assert.equal(classifyStreamFailure({ type: 'content_filter' }), undefined);
  assert.equal(classifyStreamFailure({}), undefined);
});

test('a Retry-After later than the initial cooldown is honored', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const failure = classifyRouteFailure(provider, 'm', 429, new Headers({ 'retry-after': '3600' }), {}, now);
  assert.ok(failure);
  assert.equal(failure.until, '2026-01-01T01:00:00.000Z');
  const store = makeStore(() => now);
  const status = store.mark('p', 'm', failure, 429, '');
  assert.ok(status);
  assert.equal(status.until, '2026-01-01T01:00:00.000Z');
});

test('the gateway reports client faults by attempt and never double counts one attempt', async () => {
  const clock = fakeClock();
  const model = { publicId: 'test/alpha', provider: 'test', id: 'alpha', protocols: ['openai_chat'] };
  const catalog = {
    providers: () => [provider],
    gatewayModels: () => [model],
    resolveGatewayModel: () => ({ provider, model: { id: 'alpha', reasoningEfforts: ['none'] }, capability: { endpoint: 'http://127.0.0.1:1/v1', protocol: 'openai_chat' }, publicId: 'test/alpha', upstreamModel: 'alpha' }),
  } as unknown as Catalog;
  const providers = {
    credential: async () => ({ value: 'secret' }),
    quotaPools: () => [],
    resolveUpstreamModel: (_provider: unknown, upstreamModel: string) => upstreamModel,
  } as unknown as ProviderRuntime;

  const gateway = createModelGateway({ catalog, providers, now: clock.now });
  try {
    gateway.beginRouteAttempt('test/alpha', 'attempt-1');
    gateway.reportRouteFault('test/alpha', 'attempt-1', 'transport');
    const status = gateway.routeStatus('test/alpha');
    assert.equal(status?.phase, 'open');
    assert.equal(status?.faultKind, 'transport');

    // The same attempt is never double counted: a duplicate report is ignored.
    const until = status?.until;
    gateway.reportRouteFault('test/alpha', 'attempt-1', 'transport');
    assert.equal(gateway.routeStatus('test/alpha')?.until, until);

    // Finishing the attempt leaves it eligible for a later, unambiguous report.
    gateway.completeRouteAttempt('test/alpha', 'attempt-1');
  } finally {
    await gateway.close();
  }
});

test('a settled attempt suppresses a duplicate client report in either order', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  // Client report first: the gateway's later server-side fault is stale.
  store.beginAttempt('p', 'm', 'a1');
  const guard = store.capture('p', 'm');
  store.reportAttemptFault('p', 'm', 'a1', 'transport', 502);
  const first = store.status('p', 'm');
  assert.equal(first?.faultKind, 'transport');
  clock.advance(5_000);
  store.markAttemptFault('p', 'm', 'a1', transportFailure(), 502, '', guard);
  assert.equal(store.status('p', 'm')?.until, first?.until);
  // Server-side fault first: the client report of the same attempt is dropped.
  store.beginAttempt('p', 'm', 'b2');
  store.markAttemptFault('p', 'm', 'b2', transportFailure(), 502, '', store.capture('p', 'm'));
  const settled = store.status('p', 'm');
  assert.equal(store.reportAttemptFault('p', 'm', 'b2', 'transport', 502), undefined);
  assert.equal(store.status('p', 'm')?.until, settled?.until);
});

test('a stale failure after a recovery never rebuilds the cleared fault', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm', transportFailure(), 502, '');
  const guard = store.capture('p', 'm');
  store.success('p', 'm', store.capture('p', 'm'));
  assert.equal(store.status('p', 'm'), undefined);
  // The in-flight failure that started before the recovery is stale.
  assert.equal(store.mark('p', 'm', transportFailure(), 502, '', guard), undefined);
  assert.equal(store.status('p', 'm'), undefined);
});
