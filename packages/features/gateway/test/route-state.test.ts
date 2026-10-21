import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderDefinition } from '@wrenyard/providers/base';
import { RouteStateStore, type RouteStateChangedEvent } from '../src/route-state.ts';
import { classifyRouteFailure, classifyStreamFailure } from '../src/route-failure.ts';

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

const quotaFailure = () => ({ state: 'quota_exhausted' as const, scope: 'pool' as const, faultKind: 'quota_exhausted' as const });
const modelGoneFailure = () => ({ state: 'model_unavailable' as const, scope: 'route' as const, faultKind: 'model_unavailable' as const });
const authFailure = () => ({ state: 'auth_failed' as const, scope: 'provider' as const, faultKind: 'auth_failed' as const });

test('a route fault is isolated to its exact provider/model', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm1', modelGoneFailure(), 404, '');
  assert.equal(store.status('p', 'm1')?.phase, 'open');
  assert.equal(store.status('p', 'm1')?.faultKind, 'model_unavailable');
  // A sibling model of the same provider is untouched by a route-scoped fault.
  assert.equal(store.status('p', 'm2'), undefined);
  assert.equal(store.status('other', 'm1'), undefined);
});

test('a validated success restores health; a stale success cannot overwrite a newer fault', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm', modelGoneFailure(), 404, '');
  const guard = store.capture('p', 'm');
  // A newer fault generation replaces the one this call observed.
  store.mark('p', 'm', quotaFailure(), 402, '');
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
  store.mark('p', 'm1', modelGoneFailure(), 404, '');
  store.mark('p', 'm2', modelGoneFailure(), 404, '');
  store.success('p', 'm1', store.capture('p', 'm1'));
  assert.equal(store.status('p', 'm1'), undefined);
  assert.ok(store.status('p', 'm2'));
});

test('only explicit upstream answers classify as poisoning faults', () => {
  const headers = new Headers();
  // Outcomes without an explicit meaning never poison a route.
  assert.equal(classifyRouteFailure(provider, 'm', 500, headers, undefined, 0), undefined);
  assert.equal(classifyRouteFailure(provider, 'm', 503, headers, undefined, 0), undefined);
  assert.equal(classifyRouteFailure(provider, 'm', 408, headers, undefined, 0), undefined);
  // Explicit meanings classify: auth claims the provider, 404 the route, 402 the pool.
  assert.equal(classifyRouteFailure(provider, 'm', 401, headers, undefined, 0)?.faultKind, 'auth_failed');
  assert.equal(classifyRouteFailure(provider, 'm', 401, headers, undefined, 0)?.scope, 'provider');
  assert.equal(classifyRouteFailure(provider, 'm', 403, headers, undefined, 0)?.scope, 'provider');
  assert.equal(classifyRouteFailure(provider, 'm', 402, headers, undefined, 0)?.scope, 'pool');
  assert.equal(classifyRouteFailure(provider, 'm', 404, headers, undefined, 0)?.scope, 'route');
});

test('request-invalid and context-overflow errors are reported but never poison a route', () => {
  const headers = new Headers();
  assert.equal(classifyRouteFailure(provider, 'm', 400, headers, { error: { code: 'bad_field' } }, 0), undefined);
  assert.equal(classifyRouteFailure(provider, 'm', 422, headers, {}, 0), undefined);
  assert.equal(classifyRouteFailure(provider, 'm', 400, headers, { error: { code: 'context_length_exceeded' } }, 0), undefined);
});

test('in-stream error frames classify only when their meaning is explicit', () => {
  assert.equal(classifyStreamFailure({ type: 'server_error', code: 'overloaded_error' }), undefined);
  assert.equal(classifyStreamFailure({ type: 'timeout' }), undefined);
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


test('a stale failure after a recovery never rebuilds the cleared fault', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm', modelGoneFailure(), 404, '');
  const guard = store.capture('p', 'm');
  store.success('p', 'm', store.capture('p', 'm'));
  assert.equal(store.status('p', 'm'), undefined);
  // The in-flight failure that started before the recovery is stale.
  assert.equal(store.mark('p', 'm', authFailure(), 401, '', guard), undefined);
  assert.equal(store.status('p', 'm'), undefined);
});
