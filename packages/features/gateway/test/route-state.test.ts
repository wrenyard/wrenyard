import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Catalog } from '@wrenyard/providers/catalog';
import type { ProviderRuntime } from '@wrenyard/providers';
import type { ProviderDefinition } from '@wrenyard/providers/base';
import { RouteStateStore, type ProbeLease, type RouteStateChangedEvent } from '../src/route-state.ts';
import { classifyRouteFailure, classifyStreamFailure, clientTimeoutFailure, transportFailure } from '../src/route-failure.ts';
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
  store.mark('p', 'm1', clientTimeoutFailure(), 504, '');
  assert.equal(store.status('p', 'm1')?.phase, 'open');
  assert.equal(store.status('p', 'm1')?.faultKind, 'timeout');
  // A sibling model of the same provider is untouched by a route-scoped fault.
  assert.equal(store.status('p', 'm2'), undefined);
  assert.equal(store.status('other', 'm1'), undefined);
});

test('cooldown expiry means half-open eligibility, never health', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm', clientTimeoutFailure(), 504, '');
  assert.equal(store.status('p', 'm')?.phase, 'open');
  clock.advance(61_000);
  const status = store.status('p', 'm');
  assert.equal(status?.phase, 'half_open');
  // Still faulted: an expired cooldown is not reported as available/recovered.
  assert.equal(status?.state, 'model_unavailable');
  assert.notEqual(status?.state, 'available');
});

test('only one concurrent half-open probe lease exists per fault scope', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm', clientTimeoutFailure(), 504, '');
  clock.advance(61_000);
  const first = store.acquireProbe('p', 'm');
  assert.ok(first);
  // A second concurrent caller for the same scope is skipped.
  assert.equal(store.acquireProbe('p', 'm'), undefined);
  // Releasing on cancellation lets a later caller probe again.
  store.releaseProbe(first, 'cancelled');
  assert.ok(store.acquireProbe('p', 'm'));
});

test('a failed half-open probe backs off exponentially, capped at ten minutes', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm', clientTimeoutFailure(), 504, '');
  const expected = [60_000, 120_000, 240_000, 480_000, 600_000, 600_000];
  for (const delta of expected) {
    clock.advance(20 * 60_000);
    assert.equal(store.status('p', 'm')?.phase, 'half_open');
    const lease = store.acquireProbe('p', 'm');
    assert.ok(lease);
    store.releaseProbe(lease, 'failure');
    const after = store.status('p', 'm');
    assert.equal(after?.phase, 'open');
    assert.equal(Date.parse(after!.until) - clock.now(), delta);
  }
});

test('a validated success restores health; a stale success cannot overwrite a newer fault', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm', clientTimeoutFailure(), 504, '');
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
  store.mark('p', 'm1', clientTimeoutFailure(), 504, '');
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
  assert.equal(clientTimeoutFailure().faultKind, 'timeout');
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

test('the gateway reports client faults by attempt and surfaces the phase in /models', async () => {
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
    gateway.reportRouteFault('test/alpha', 'attempt-1', 'timeout');
    const status = gateway.routeStatus('test/alpha');
    assert.equal(status?.phase, 'open');
    assert.equal(status?.faultKind, 'timeout');

    // The same attempt is never double counted: a duplicate report is ignored.
    const until = status?.until;
    gateway.reportRouteFault('test/alpha', 'attempt-1', 'timeout');
    assert.equal(gateway.routeStatus('test/alpha')?.until, until);

    clock.advance(61_000);
    // Cooldown expiry is half-open eligibility: still faulted, never recovered.
    assert.equal(gateway.routeStatus('test/alpha')?.phase, 'half_open');
    assert.equal(gateway.routeStatus('test/alpha')?.state, 'model_unavailable');

    // The faulted route stays visible in the model-list projection with its phase.
    const connection = await gateway.connection('http://127.0.0.1:1');
    const entry = connection.models.find((row) => row.publicId === 'test/alpha') as { routePhase?: string } | undefined;
    assert.equal(entry?.routePhase, 'half_open');

    // Finishing the attempt leaves it eligible for a later, unambiguous report.
    gateway.completeRouteAttempt('test/alpha', 'attempt-1');
  } finally {
    await gateway.close();
  }
});

test('one probe lease atomically covers every applicable scope and blocks concurrent callers', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm', clientTimeoutFailure(), 504, '');                              // route scope, 60s
  store.mark('p', 'm', { state: 'auth_failed', scope: 'provider' }, 401, 'secret');   // provider scope, 30min
  // The route's own cooldown expired, but the provider scope is still open: never probe.
  clock.advance(61_000);
  assert.equal(store.status('p', 'm')?.phase, 'open');
  assert.equal(store.admit('p', 'm').kind, 'blocked');
  // Once every scope is half-open, exactly one caller takes an atomic lease over both.
  clock.advance(30 * 60_000);
  const admission = store.admit('p', 'm');
  assert.equal(admission.kind, 'probe');
  const lease = (admission as { lease: ProbeLease }).lease;
  assert.equal(lease.entries.length, 2);
  assert.equal(store.admit('p', 'm').kind, 'blocked');
  store.releaseProbe(lease, 'success');
  assert.equal(store.status('p', 'm'), undefined);
});

test('an expired then reacquired lease is never cleared by a stale completion', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm', clientTimeoutFailure(), 504, '');
  clock.advance(61_000);
  const first = store.acquireProbe('p', 'm');
  assert.ok(first);
  // Bounded expiry releases the lease token without changing health.
  store.releaseProbe(first);
  assert.equal(store.status('p', 'm')?.phase, 'half_open');
  const second = store.acquireProbe('p', 'm');
  assert.ok(second);
  // Completing the stale first lease must not clear the reacquired one.
  store.releaseProbe(first, 'success');
  assert.equal(store.status('p', 'm')?.phase, 'half_open');
  store.releaseProbe(second, 'failure');
  assert.equal(store.status('p', 'm')?.phase, 'open');
});

test('cancellation releases the lease without declaring health or recording a failure', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm', clientTimeoutFailure(), 504, '');
  clock.advance(61_000);
  const lease = store.acquireProbe('p', 'm');
  assert.ok(lease);
  store.releaseProbe(lease, 'cancelled');
  const status = store.status('p', 'm');
  assert.equal(status?.phase, 'half_open');
  assert.equal(status?.state, 'model_unavailable');
  assert.equal(status?.lastProbe, 'cancelled');
  assert.ok(store.acquireProbe('p', 'm'));
});

test('a settled attempt suppresses a duplicate client report in either order', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  // Client report first: the gateway's later server-side timeout is stale.
  store.beginAttempt('p', 'm', 'a1');
  const guard = store.capture('p', 'm');
  store.reportAttemptFault('p', 'm', 'a1', 'timeout', 504);
  const first = store.status('p', 'm');
  assert.equal(first?.faultKind, 'timeout');
  clock.advance(5_000);
  store.markAttemptFault('p', 'm', 'a1', clientTimeoutFailure(), 504, '', guard);
  assert.equal(store.status('p', 'm')?.until, first?.until);
  // Server-side timeout first: the client report of the same attempt is dropped.
  store.beginAttempt('p', 'm', 'b2');
  store.markAttemptFault('p', 'm', 'b2', transportFailure(), 502, '', store.capture('p', 'm'));
  const settled = store.status('p', 'm');
  assert.equal(store.reportAttemptFault('p', 'm', 'b2', 'timeout', 504), undefined);
  assert.equal(store.status('p', 'm')?.until, settled?.until);
});

test('a probe settles once whether the client or the pipeline reports the same attempt', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);

  // Client-first: the report settles the very probe this attempt was admitted with.
  store.mark('p', 'm', clientTimeoutFailure(), 504, '');
  clock.advance(61_000);
  store.beginAttempt('p', 'm', 'a1');
  const first = store.admit('p', 'm', 'a1');
  assert.equal(first.kind, 'probe');
  const lease = (first as { lease: ProbeLease }).lease;
  store.reportAttemptFault('p', 'm', 'a1', 'timeout', 504);
  const afterClient = store.status('p', 'm');
  assert.equal(afterClient?.phase, 'open');
  assert.equal(Date.parse(afterClient!.until) - clock.now(), 60_000);
  // The pipeline's later settlement of the same probe is fenced out: one backoff only.
  store.releaseProbe(lease, 'failure', clientTimeoutFailure(), 504);
  assert.equal(store.status('p', 'm')?.until, afterClient?.until);

  // Server-first: the pipeline settles, and a late client report is dropped.
  clock.advance(10 * 60_000);
  store.beginAttempt('p', 'm', 'a2');
  const second = store.admit('p', 'm', 'a2');
  assert.equal(second.kind, 'probe');
  store.releaseProbe((second as { lease: ProbeLease }).lease, 'failure', clientTimeoutFailure(), 504);
  const afterServer = store.status('p', 'm');
  // The backoff is monotonic: the second probe failure doubles it.
  assert.equal(Date.parse(afterServer!.until) - clock.now(), 120_000);
  store.reportAttemptFault('p', 'm', 'a2', 'timeout', 504);
  assert.equal(store.status('p', 'm')?.until, afterServer?.until);
});

test('a 429 during a probe keeps its Retry-After floor and updates the fault reason', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm', clientTimeoutFailure(), 504, '');
  clock.advance(61_000);
  const lease = store.acquireProbe('p', 'm');
  assert.ok(lease);
  const until = new Date(clock.now() + 3_600_000).toISOString();
  store.releaseProbe(lease, 'failure', { state: 'rate_limited', scope: 'pool', faultKind: 'rate_limited', until }, 429);
  const status = store.status('p', 'm');
  assert.equal(status?.faultKind, 'rate_limited');
  assert.equal(status?.until, until);
});

test('a probe that discovers a new pool scope faults that scope too', () => {
  const clock = fakeClock();
  const store = new RouteStateStore(clock.now, () => ['pool-a'], () => undefined);
  store.mark('p', 'm', clientTimeoutFailure(), 504, '');
  clock.advance(61_000);
  const lease = store.acquireProbe('p', 'm');
  assert.ok(lease);
  store.releaseProbe(lease, 'failure', { state: 'rate_limited', scope: 'pool', faultKind: 'rate_limited', quotaPoolId: 'pool-a' }, 429);
  assert.equal(store.status('p', 'm')?.faultKind, 'rate_limited');
  assert.equal(store.admit('p', 'm').kind, 'blocked');
});

test('a stale failure after a recovery never rebuilds the cleared fault', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm', clientTimeoutFailure(), 504, '');
  const guard = store.capture('p', 'm');
  store.success('p', 'm', store.capture('p', 'm'));
  assert.equal(store.status('p', 'm'), undefined);
  // The in-flight failure that started before the recovery is stale.
  assert.equal(store.mark('p', 'm', transportFailure(), 502, '', guard), undefined);
  assert.equal(store.status('p', 'm'), undefined);
});

test('while every applicable scope is leased, status projects a future retry, never zero', () => {
  const clock = fakeClock();
  const store = makeStore(clock.now);
  store.mark('p', 'm', clientTimeoutFailure(), 504, '');
  store.mark('p', 'm', { state: 'auth_failed', scope: 'provider' }, 401, 'secret');
  clock.advance(31 * 60_000);
  const admission = store.admit('p', 'm');
  assert.equal(admission.kind, 'probe');
  const status = store.status('p', 'm');
  assert.equal(status?.phase, 'half_open');
  const retryAt = status?.nextProbeAt ?? status?.until;
  assert.ok(Date.parse(retryAt!) > clock.now());
});
