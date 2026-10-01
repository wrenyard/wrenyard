import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError, type AgentClient } from '@wrenyard/clients';
import { providerQuotas } from '@wrenyard/providers';
import { QuotaService } from '../src/index.ts';

interface ScriptedResponse {
    status: number;
    retryAfterSeconds?: number;
}

interface ScriptedHttp {
    readonly client: AgentClient;
    readonly calls: () => number;
}

/**
 * Scripted fake of the Anthropic OAuth usage endpoint. Every `readAccount`
 * call consumes the next response: a 200 yields a successful observation and a
 * 429 throws the same `rate_limited` ClientError that `requestJson` produces.
 */
function scriptedClaudeClient(responses: readonly ScriptedResponse[], clock: () => number): ScriptedHttp {
    let calls = 0;
    const client: AgentClient = {
        id: 'claude',
        capabilities: { run: false, account: true, resume: false },
        inspect: async () => ({ installation: { state: 'missing' }, authentication: 'unknown' }),
        start: async () => { throw new Error('claude start is not used by this test'); },
        readAccount: async () => {
            const response = responses[Math.min(calls, responses.length - 1)];
            calls += 1;
            if (response.status === 429)
                throw new ClientError('rate_limited', 'Upstream rate limited',
                    response.retryAfterSeconds === undefined ? undefined : response.retryAfterSeconds * 1000);
            return {
                source: 'oauth-api',
                fetched_at: new Date(clock()).toISOString(),
                data: {
                    current_interval_total_count: 100,
                    current_interval_usage_count: 10,
                    current_interval_reset_at: new Date(clock() + 3_600_000).toISOString(),
                },
            };
        },
    };
    return { client, calls: () => calls };
}

function makeService(responses: readonly ScriptedResponse[], clock: () => number): { service: QuotaService; calls: () => number } {
    const http = scriptedClaudeClient(responses, clock);
    const service = new QuotaService({
        providers: new Map([['claude-coding', providerQuotas.get('claude-coding')!]]),
        clients: new Map([['claude', http.client]]),
        now: clock,
    });
    return { service, calls: http.calls };
}

test('QuotaService caches a success, backs off on 429, and recovers after Retry-After', async () => {
    let clock = 0;
    const { service, calls } = makeService([{ status: 200 }, { status: 429, retryAfterSeconds: 120 }, { status: 200 }], () => clock);

    const first = await service.fetch('claude-coding');
    assert.equal(calls(), 1);
    assert.equal(first?.status, 'ok');
    assert.equal(first?.stale, false);

    // Within minRefreshMs (5 min) the cached success is returned with no request.
    clock = 60_000;
    const cached = await service.fetch('claude-coding');
    assert.equal(calls(), 1);
    assert.deepEqual(cached, first);

    // Past minRefreshMs the read is allowed again and hits the 429.
    clock = 300_000;
    const limited = await service.fetch('claude-coding');
    assert.equal(calls(), 2);
    assert.equal(limited?.status, 'ok');
    assert.equal(limited?.stale, true);
    assert.equal(limited?.code, 'rate_limited');
    assert.match(limited?.message ?? '', /retry in 2 min/);
    assert.deepEqual(limited?.windows, first?.windows);

    // Inside the Retry-After window the upstream is never polled.
    clock = 300_000 + 60_000;
    const duringCooldown = await service.fetch('claude-coding');
    assert.equal(calls(), 2);
    assert.equal(duringCooldown?.stale, true);
    assert.equal(duringCooldown?.code, 'rate_limited');

    // Once Retry-After elapses the upstream is polled and recovers.
    clock = 300_000 + 120_000;
    const recovered = await service.fetch('claude-coding');
    assert.equal(calls(), 3);
    assert.equal(recovered?.status, 'ok');
    assert.equal(recovered?.stale, false);
});

test('QuotaService reports a cold-start 429 as a rate_limited error and recovers after Retry-After', async () => {
    let clock = 0;
    const { service, calls } = makeService([{ status: 429, retryAfterSeconds: 120 }, { status: 200 }], () => clock);

    const coldStart = await service.fetch('claude-coding');
    assert.equal(calls(), 1);
    assert.equal(coldStart?.status, 'error');
    assert.equal(coldStart?.stale, false);
    assert.equal(coldStart?.code, 'rate_limited');
    assert.match(coldStart?.message ?? '', /retry in 2 min/);

    // Still cooling down: the error row is returned without another request.
    clock = 60_000;
    const stillCooling = await service.fetch('claude-coding');
    assert.equal(calls(), 1);
    assert.equal(stillCooling?.code, 'rate_limited');

    clock = 120_000;
    const recovered = await service.fetch('claude-coding');
    assert.equal(calls(), 2);
    assert.equal(recovered?.status, 'ok');
    assert.equal(recovered?.stale, false);
});
