import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { AgentRequest } from '../src/index.ts';
import { assertLaunch, isReasoningEffort } from '../src/native.ts';
import { launchClaude } from '../../claude/src/launch.ts';
import { launchCodeBuddy } from '../../codebuddy/src/launch.ts';
import { launchCodex } from '../../codex/src/launch.ts';
import { launchGrok } from '../../grok/src/launch.ts';
import { launchOpenCode } from '../../opencode/src/launch.ts';
import { prepareDshLaunch } from '../../dsh/src/launch.ts';
import {
    DSH_REASONING_EFFORT_ENV,
    DSH_REASONING_EFFORT_HEADER,
    DSH_REASONING_EFFORT_PLUGIN_SOURCE,
    DSH_REASONING_EFFORT_URL_ENV,
} from '../../dsh/src/reasoning-effort-asset.ts';

/** A fully resolved launch request; overrides name the exact behaviour under test. */
function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
    return {
        model: 'model-x',
        prompt: 'Hello.',
        cwd: '/workspace',
        reasoningEffort: 'medium',
        clientReasoningEffort: 'medium-wire',
        ...overrides,
    };
}

interface Sandbox {
    env: NodeJS.ProcessEnv;
    readonly bin: string;
}

/**
 * Give the adapter under test a throwaway PATH with empty stand-ins for each
 * executable name, an isolated state/home root so no adapter writes into the
 * real user profile, and clean up everything afterwards. No client is launched.
 */
async function withSandbox(names: readonly string[], run: (sandbox: Sandbox) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'wrenyard-effort-'));
    const bin = join(root, 'bin');
    const state = join(root, 'state');
    const home = join(root, 'home');
    await mkdir(bin, { recursive: true });
    await mkdir(state, { recursive: true });
    await mkdir(home, { recursive: true });
    for (const name of names) {
        for (const candidate of [name, `${name}.cmd`, `${name}.exe`])
            await writeFile(join(bin, candidate), '');
    }
    const priorState = process.env.XDG_STATE_HOME;
    const priorHome = process.env.HOME;
    const priorProfile = process.env.USERPROFILE;
    process.env.XDG_STATE_HOME = state;
    // `clientStateDir` and `homedir()` read the process environment, so the
    // adapter under test must observe the sandbox home too, not the real one.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const env: NodeJS.ProcessEnv = {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        HOME: home,
        USERPROFILE: home,
        XDG_STATE_HOME: state,
    };
    try {
        await run({ env, bin });
    }
    finally {
        if (priorState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = priorState;
        if (priorHome === undefined) delete process.env.HOME;
        else process.env.HOME = priorHome;
        if (priorProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = priorProfile;
        await rm(root, { recursive: true, force: true });
    }
}

test('assertLaunch requires an exact public reasoning-effort level', () => {
    const incomplete = { model: 'model-x', prompt: 'Hello.', cwd: '/workspace' } as unknown as AgentRequest;
    assert.throws(() => assertLaunch(incomplete), /reasoning effort/);

    const misspelled = { ...incomplete, reasoningEffort: 'midium' } as unknown as AgentRequest;
    assert.throws(() => assertLaunch(misspelled), /reasoning effort/);

    const none = { ...incomplete, reasoningEffort: 'none' } as unknown as AgentRequest;
    assert.doesNotThrow(() => assertLaunch(none));

    assert.equal(isReasoningEffort('high'), true);
    assert.equal(isReasoningEffort('midium'), false);
    assert.equal(isReasoningEffort(undefined), false);
});

test('claude transports the mapped effort through the per-run environment', async () => {
    await withSandbox(['claude'], async ({ env }) => {
        const spec = await launchClaude(request({ reasoningEffort: 'high', clientReasoningEffort: 'high-wire' }), env);
        assert.equal(spec.env.CLAUDE_CODE_EFFORT_LEVEL, 'high-wire');
        // The effort rides the environment, never a config file or a CLI flag.
        assert.equal(spec.files, undefined);
    });
});

test('codebuddy carries the mapped effort in a per-run settings JSON and writes no file', async () => {
    const spec = await launchCodeBuddy(
        request({ reasoningEffort: 'high', clientReasoningEffort: 'high-wire' }),
        {},
        '/fake/bin/codebuddy',
    );
    const index = spec.args.indexOf('--settings');
    assert.ok(index >= 0, 'codebuddy must pass --settings');
    assert.deepEqual(JSON.parse(spec.args[index + 1]!), { reasoningEffort: 'high-wire' });
    // --settings rides immediately before the terminal -p prompt flag.
    assert.ok(index < spec.args.indexOf('-p'));
    assert.equal(spec.files, undefined, 'codebuddy must not write any persistent config');
});

test('codebuddy requires a mapped effort rather than dropping it silently', async () => {
    await assert.rejects(
        launchCodeBuddy(request({ clientReasoningEffort: undefined }), {}, '/fake/bin/codebuddy'),
        /mapped reasoning effort/,
    );
});

test('codex consumes the mapped wire alias as a config override', async () => {
    await withSandbox(['codex'], async ({ env }) => {
        const spec = await launchCodex(
            request({ model: 'gpt-5-codex', reasoningEffort: 'high', clientReasoningEffort: 'high-wire' }),
            env,
            join(env.HOME ?? tmpdir(), 'codex-home'),
        );
        assert.ok(spec.args.includes('model_reasoning_effort="high-wire"'));
    });
});

test('grok consumes the mapped wire alias as an --reasoning-effort flag', async () => {
    await withSandbox(['grok'], async ({ env }) => {
        const spec = await launchGrok(request({ model: 'grok-4', reasoningEffort: 'high', clientReasoningEffort: 'high-wire' }), env);
        const index = spec.args.indexOf('--reasoning-effort');
        assert.ok(index >= 0);
        assert.equal(spec.args[index + 1], 'high-wire');
    });
});

test('opencode gateway declares the effort header and a bound variant', async () => {
    await withSandbox(['opencode'], async ({ env }) => {
        env.WRENYARD_GATEWAY_OPENAI_CHAT_URL = 'http://127.0.0.1:8080/v1/chat/completions';
        const spec = await launchOpenCode(
            request({ model: 'kimi-k3', provider: 'anthropic', mode: 'gateway', reasoningEffort: 'high', clientReasoningEffort: 'high-wire' }),
            env,
        );
        const config = JSON.parse(String(spec.files?.[0]?.data));
        const provider = config.provider.wrenyard;
        // The public level rides the provider header; the Gateway owns conversion.
        assert.equal(provider.options.headers['x-wrenyard-reasoning-effort'], 'high');
        assert.equal(provider.models['kimi-k3'].variants['high-wire'].reasoningEffort, 'high-wire');
        assert.ok(spec.args.includes('--variant'));
        assert.equal(spec.args[spec.args.indexOf('--variant') + 1], 'high-wire');
        assert.equal(spec.args[spec.args.indexOf('-m') + 1], 'wrenyard/kimi-k3');
    });
});

test('opencode native zen selects opencode/<model> and binds the variant', async () => {
    await withSandbox(['opencode'], async ({ env }) => {
        const spec = await launchOpenCode(
            request({ model: 'kimi-k3', provider: 'opencode-zen', reasoningEffort: 'high', clientReasoningEffort: 'high-wire' }),
            env,
        );
        const config = JSON.parse(String(spec.files?.[0]?.data));
        assert.equal(config.provider.opencode.models['kimi-k3'].variants['high-wire'].reasoningEffort, 'high-wire');
        assert.equal(spec.args[spec.args.indexOf('-m') + 1], 'opencode/kimi-k3');
        assert.equal(spec.args[spec.args.indexOf('--variant') + 1], 'high-wire');
    });
});

test('dsh installs the effort plugin for a gateway route and scrubs stale effort env', async () => {
    await withSandbox(['dsh'], async ({ env, bin }) => {
        env.WRENYARD_DSH_BIN = join(bin, 'dsh');
        env.WRENYARD_GATEWAY_OPENAI_CHAT_URL = 'http://127.0.0.1:8080/v1/chat/completions';
        env.WRENYARD_GATEWAY_TOKEN = 'gateway-token';
        env.WRENYARD_REASONING_STALE = 'leftover';
        const launch = await prepareDshLaunch(
            request({ model: 'claude', canonicalModel: 'claude', provider: 'anthropic', mode: 'gateway', reasoningEffort: 'high', clientReasoningEffort: undefined }),
            undefined,
            env,
        );
        try {
            assert.equal(launch.spec.env[DSH_REASONING_EFFORT_ENV], 'high');
            assert.equal(launch.spec.env[DSH_REASONING_EFFORT_URL_ENV], 'http://127.0.0.1:8080/v1/chat/completions');
            assert.equal(launch.spec.env.WRENYARD_REASONING_STALE, undefined);
            const patch = await readFile(join(launch.spec.env.DSH_HOME!, 'wrenyard-loader-patch.yaml'), 'utf8');
            assert.match(patch, /wrenyard-dsh-reasoning-effort/);
        }
        finally {
            await launch.cleanup();
        }
    });
});

test('the generated dsh plugin adds the header only for the configured url', async () => {
    const module = await import(`data:text/javascript;base64,${Buffer.from(DSH_REASONING_EFFORT_PLUGIN_SOURCE).toString('base64')}`);
    const configured = 'http://127.0.0.1:8080/v1/chat/completions';
    const priorFetch = globalThis.fetch;
    const priorEffort = process.env[DSH_REASONING_EFFORT_ENV];
    const priorUrl = process.env[DSH_REASONING_EFFORT_URL_ENV];
    const seen: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
        const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
        seen.push({ url, headers });
        return new Response('{}');
    }) as unknown as typeof fetch;
    process.env[DSH_REASONING_EFFORT_ENV] = 'high';
    process.env[DSH_REASONING_EFFORT_URL_ENV] = configured;
    try {
        module.apply();
        // A plain URL string to the configured endpoint gains the header.
        await globalThis.fetch(configured, { method: 'POST' });
        // An unrelated URL must pass through untouched.
        await globalThis.fetch('http://127.0.0.1:8080/v1/models', { method: 'POST' });
        // A Request input keeps its Request semantics and gains the header.
        await globalThis.fetch(new Request(configured, { method: 'POST' }));

        assert.equal(seen[0]!.headers.get(DSH_REASONING_EFFORT_HEADER), 'high');
        assert.equal(seen[1]!.headers.get(DSH_REASONING_EFFORT_HEADER), null);
        assert.equal(seen[2]!.headers.get(DSH_REASONING_EFFORT_HEADER), 'high');
    }
    finally {
        globalThis.fetch = priorFetch;
        if (priorEffort === undefined) delete process.env[DSH_REASONING_EFFORT_ENV];
        else process.env[DSH_REASONING_EFFORT_ENV] = priorEffort;
        if (priorUrl === undefined) delete process.env[DSH_REASONING_EFFORT_URL_ENV];
        else process.env[DSH_REASONING_EFFORT_URL_ENV] = priorUrl;
    }
});

test('Claude Haiku budget mapping scrubs inherited effort settings', async () => {
    await withSandbox(['claude'], async ({ env }) => {
        env.CLAUDE_CODE_EFFORT_LEVEL = 'max';
        env.MAX_THINKING_TOKENS = '32768';
        const spec = await launchClaude(request({ model: 'claude-haiku-4-5', reasoningEffort: 'none', clientReasoningEffort: undefined, clientReasoningEnvironment: { MAX_THINKING_TOKENS: '0' } }), env);
        assert.equal(spec.env.MAX_THINKING_TOKENS, '0');
        assert.equal(spec.env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
    });
});

test('OpenCode Messages Gateway uses the Anthropic SDK and endpoint', async () => {
    await withSandbox(['opencode'], async ({ env }) => {
        env.WRENYARD_GATEWAY_ANTHROPIC_URL = 'http://127.0.0.1:8080/messages';
        env.WRENYARD_GATEWAY_OPENAI_CHAT_URL = 'http://127.0.0.1:8080/v1/chat/completions';
        const spec = await launchOpenCode(request({ provider: 'anthropic', model: 'anthropic/claude-opus-5-5', mode: 'gateway', protocol: 'anthropic_messages', reasoningEffort: 'high' }), env);
        const provider = JSON.parse(String(spec.files?.[0]?.data)).provider.wrenyard;
        assert.equal(provider.npm, '@ai-sdk/anthropic');
        assert.equal(provider.options.baseURL, env.WRENYARD_GATEWAY_ANTHROPIC_URL);
        assert.equal(provider.options.headers['x-wrenyard-reasoning-effort'], 'high');
    });
});
