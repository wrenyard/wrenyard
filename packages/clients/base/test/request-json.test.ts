import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError, requestJson } from '../src/index.ts';

/** Install a fake fetch for the duration of `run`, restoring the original after. */
async function withFakeFetch(handler: typeof fetch, run: () => Promise<void>): Promise<void> {
    const original = globalThis.fetch;
    globalThis.fetch = handler;
    try {
        await run();
    }
    finally {
        globalThis.fetch = original;
    }
}

test('requestJson maps HTTP 429 to rate_limited and carries the Retry-After delay', async () => {
    await withFakeFetch(
        async () => new Response(null, { status: 429, headers: { 'retry-after': '120' } }),
        async () => {
            await assert.rejects(requestJson('https://example.test/usage', {}), (error: unknown) => {
                assert.ok(error instanceof ClientError);
                assert.equal(error.code, 'rate_limited');
                assert.equal(error.retryAfterMs, 120_000);
                return true;
            });
        },
    );
});

test('requestJson leaves retryAfterMs undefined when a 429 has no Retry-After', async () => {
    await withFakeFetch(
        async () => new Response(null, { status: 429 }),
        async () => {
            await assert.rejects(requestJson('https://example.test/usage', {}), (error: unknown) => {
                assert.ok(error instanceof ClientError);
                assert.equal(error.code, 'rate_limited');
                assert.equal(error.retryAfterMs, undefined);
                return true;
            });
        },
    );
});

test('requestJson parses a successful JSON body unchanged', async () => {
    await withFakeFetch(
        async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
        async () => {
            assert.deepEqual(await requestJson('https://example.test/usage', {}), { ok: true });
        },
    );
});
