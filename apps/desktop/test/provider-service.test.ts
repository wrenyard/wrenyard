import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  API_KEY_PROVIDER_IDS,
  PROVIDER_LIST_ARGS,
  ProviderService,
  type ProviderCommandResult,
  type ProviderCommandRunner,
} from '../src/provider-service.js';

class FakeRunner implements ProviderCommandRunner {
  calls: Array<{ args: string[]; input?: string }> = [];

  constructor(public result: ProviderCommandResult) {}

  async run(args: readonly string[], input?: string): Promise<ProviderCommandResult> {
    this.calls.push({ args: [...args], input });
    return this.result;
  }
}

function serviceWith(result: Partial<ProviderCommandResult>): { service: ProviderService; runner: FakeRunner } {
  const runner = new FakeRunner({ stdout: '', stderr: '', code: 0, ...result });
  return { service: new ProviderService({ runtimeCommand: '/fake/forge', runner }), runner };
}

const LIST_ENTRIES = [
  { id: 'kimi-coding', api_kind: 'anthropic', auth_ok: true },
  { id: 'deepseek', api_kind: 'openai', auth_ok: false },
  { id: 'codex', api_kind: 'openai', auth_ok: false },
  { id: 'cursor', api_kind: '', auth_ok: true },
  { id: 'spacex-ai', api_kind: 'openai', auth_ok: false },
  { id: 'codebuddy-local', api_kind: '', auth_ok: true },
  { id: 'custom-pool', api_kind: '', auth_ok: true },
];

test('provider JSON is strictly projected with product auth modes', async () => {
  const { service, runner } = serviceWith({ stdout: JSON.stringify(LIST_ENTRIES) });
  const statuses = await service.listProviders();
  assert.deepEqual(statuses, [
    { id: 'kimi-coding', configured: true, authMode: 'api-key' },
    { id: 'deepseek', configured: false, authMode: 'environment' },
    { id: 'codex', configured: false, authMode: 'native' },
    { id: 'cursor', configured: true, authMode: 'native' },
    { id: 'spacex-ai', configured: false, authMode: 'native' },
    { id: 'codebuddy', configured: true, authMode: 'native' },
    { id: 'custom-pool', configured: true, authMode: 'none' },
  ]);
  assert.deepEqual(runner.calls[0].args, [...PROVIDER_LIST_ARGS]);
});

test('every codebuddy-* legacy id collapses into one canonical codebuddy provider', async () => {
  const entries = [
    { id: 'codebuddy', api_kind: '', auth_ok: true },
    { id: 'codebuddy-ioa', api_kind: '', auth_ok: false },
    { id: 'codebuddy-local', api_kind: '', auth_ok: false },
  ];
  const { service } = serviceWith({ stdout: JSON.stringify(entries) });
  const statuses = await service.listProviders();
  assert.deepEqual(statuses, [{ id: 'codebuddy', configured: true, authMode: 'native' }]);
});

test('duplicate codebuddy variants merge with configured=true winning', async () => {
  const entries = [
    { id: 'codebuddy-ioa', api_kind: '', auth_ok: true },
    { id: 'codebuddy', api_kind: '', auth_ok: false },
    { id: 'codebuddy-legacy', api_kind: '', auth_ok: false },
  ];
  const { service } = serviceWith({ stdout: JSON.stringify(entries) });
  const statuses = await service.listProviders();
  assert.deepEqual(statuses, [{ id: 'codebuddy', configured: true, authMode: 'native' }]);
});

test('legacy xai discovery collapses into the canonical spacex-ai provider', async () => {
  const entries = [
    { id: 'xai', api_kind: '', auth_ok: true },
    { id: 'spacex-ai', api_kind: '', auth_ok: false },
  ];
  const { service } = serviceWith({ stdout: JSON.stringify(entries) });
  const statuses = await service.listProviders();
  assert.deepEqual(statuses, [{ id: 'spacex-ai', configured: true, authMode: 'native' }]);
});

test('malformed provider output is rejected', async () => {
  const malformedOutputs = [
    '{"not":"an array"}',
    '[{"id":"kimi-coding","api_kind":"anthropic"}]', // missing auth_ok
    '[42]', // non-object entry
    '[{"id":"","api_kind":"openai","auth_ok":false}]', // empty id
    JSON.stringify([{ id: 'x'.repeat(300), api_kind: 'openai', auth_ok: false }]), // overlong id
  ];
  for (const stdout of malformedOutputs) {
    const { service } = serviceWith({ stdout });
    await assert.rejects(() => service.listProviders());
  }
});

test('provider output with too many entries is rejected', async () => {
  const entries = Array.from({ length: 65 }, (_, i) => ({ id: `p${i}`, api_kind: 'openai', auth_ok: false }));
  const { service } = serviceWith({ stdout: JSON.stringify(entries) });
  await assert.rejects(() => service.listProviders());
});

test('non-zero runtime exit rejects provider listing', async () => {
  const { service } = serviceWith({ stdout: '', stderr: 'forge: quota unavailable', code: 1 });
  await assert.rejects(() => service.listProviders(), /Provider 目录/);
});

test('API key writes are restricted to the provider whitelist', async () => {
  const { service } = serviceWith({});
  await assert.rejects(() => service.configureApiKey('deepseek', 'sk-test'));
  await assert.rejects(() => service.configureApiKey('not-a-provider', 'sk-test'));
  assert.equal(API_KEY_PROVIDER_IDS.has('kimi-coding'), true);
  assert.equal(API_KEY_PROVIDER_IDS.has('zhipu-coding'), true);
  for (const id of ['anthropic-api', 'minimax', 'minimax-coding', 'moonshot', 'openai', 'qwen', 'qwen-coding', 'tokenhub', 'volcengine', 'zhipu']) {
    assert.equal(API_KEY_PROVIDER_IDS.has(id), true, `${id} must accept a runtime-managed API key`);
  }
});

test('API key validation rejects empty and oversized values', async () => {
  const { service, runner } = serviceWith({});
  await assert.rejects(() => service.configureApiKey('kimi-coding', ''));
  await assert.rejects(() => service.configureApiKey('kimi-coding', '   '));
  await assert.rejects(() => service.configureApiKey('kimi-coding', 'sk-x'.repeat(2000)));
  assert.equal(runner.calls.length, 0);
});

test('API key travels only through stdin and never appears in argv or errors', async () => {
  const { service, runner } = serviceWith({});
  await service.configureApiKey('zhipu-coding', 'sk-super-secret-value');
  assert.deepEqual(runner.calls[0].args, ['auth', 'set', 'zhipu-coding', '--key-stdin']);
  assert.equal(runner.calls[0].input, 'sk-super-secret-value');
  assert.ok(runner.calls[0].args.every((arg) => !arg.includes('sk-super-secret-value')));

  runner.calls = [];
  runner.result = { stdout: '', stderr: 'auth write failed for sk-secret-abc', code: 1 };
  await assert.rejects(
    () => service.configureApiKey('kimi-coding', 'sk-secret-abc'),
    (error: unknown) => {
      assert.ok(!String(error).includes('sk-secret-abc'));
      return true;
    },
  );
});
