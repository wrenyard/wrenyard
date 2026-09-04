import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderService, type ProviderControlClient } from '../src/provider-service.js';

class FakeClient implements ProviderControlClient {
  closed = false;
  configureCalls: Array<{ providerId: string; key: string }> = [];
  async providerList() {
    return { providers: [
      {
        id: 'codebuddy',
        displayName: 'CodeBuddy',
        description: 'CodeBuddy native provider.',
        setupHint: 'Sign in through CodeBuddy.',
        configured: true,
        authMode: 'native' as const,
        protocols: ['openai_chat' as const],
        models: [{ id: 'hy4-preview-ioa', displayName: 'HY4 Preview' }],
      },
      {
        id: 'kimi-coding',
        displayName: 'Kimi Coding',
        description: 'Kimi Coding API provider.',
        setupHint: 'Configure an API key.',
        configured: false,
        authMode: 'api-key' as const,
        protocols: ['anthropic_messages' as const],
        models: [{ id: 'kimi-k2.5', displayName: 'Kimi K2.5' }],
      },
    ] };
  }
  async providerConfigure(providerId: string, key: string) {
    this.configureCalls.push({ providerId, key });
    return { ok: true as const };
  }
  close() { this.closed = true; }
}

test('provider list comes only from daemon IPC', async () => {
  const client = new FakeClient();
  const service = new ProviderService({ ipcPath: '/tmp/wrenyard.sock', clientFactory: () => client });
  assert.deepEqual(await service.listProviders(), [
    {
      id: 'codebuddy',
      displayName: 'CodeBuddy',
      description: 'CodeBuddy native provider.',
      setupHint: 'Sign in through CodeBuddy.',
      configured: true,
      authMode: 'native',
    },
    {
      id: 'kimi-coding',
      displayName: 'Kimi Coding',
      description: 'Kimi Coding API provider.',
      setupHint: 'Configure an API key.',
      configured: false,
      authMode: 'api-key',
    },
  ]);
  assert.equal(client.closed, true);
});

test('API key is sent through daemon IPC without a child process', async () => {
  const client = new FakeClient();
  const service = new ProviderService({ ipcPath: '/tmp/wrenyard.sock', clientFactory: () => client });
  await service.configureApiKey('kimi-coding', '  secret-value  ');
  assert.deepEqual(client.configureCalls, [{ providerId: 'kimi-coding', key: 'secret-value' }]);
  assert.equal(client.closed, true);
});

test('API key validation rejects empty and oversized values before IPC', async () => {
  const client = new FakeClient();
  const service = new ProviderService({ ipcPath: '/tmp/wrenyard.sock', clientFactory: () => client });
  await assert.rejects(() => service.configureApiKey('kimi-coding', ''));
  await assert.rejects(() => service.configureApiKey('kimi-coding', 'x'.repeat(4097)));
  assert.deepEqual(client.configureCalls, []);
});
