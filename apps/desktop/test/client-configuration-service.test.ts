import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ClientConfigurationDesktopService,
  type ClientConfigurationControlClient,
} from '../src/client-configuration/service.js';
import type {
  ClientConfigurationId,
  ClientConfigurationPlanDto,
  ClientModelSelectionDto,
} from '../src/client-configuration/contract.js';

const plan: ClientConfigurationPlanDto = {
  clientId: 'codex-shared',
  operation: 'apply',
  files: [{ path: '/home/.codex/config.toml', digest: 'abc', existed: true, changes: ['model'] }],
  models: ['openai/sol'],
  defaultModel: 'openai/sol',
  connectionMode: 'switching',
  effects: ['auth.json 保持不变'],
  requiresRestart: ['codex-app', 'codex-cli'],
};

class FakeClient implements ClientConfigurationControlClient {
  closed = false;
  calls: Array<{ id: ClientConfigurationId; selection?: ClientModelSelectionDto }> = [];
  async clientConfigurationSnapshot() { return { surfaces: [], configurations: [] }; }
  async clientConfigurationPlan(id: ClientConfigurationId, selection: ClientModelSelectionDto) {
    this.calls.push({ id, selection });
    return plan;
  }
  async clientConfigurationApply(value: ClientConfigurationPlanDto) {
    this.calls.push({ id: value.clientId });
    return { clientId: value.clientId, state: 'needs-restart' as const, configuredModels: [...value.models] };
  }
  async clientConfigurationPlanRestore(id: ClientConfigurationId) { return { ...plan, clientId: id, operation: 'restore' as const }; }
  async clientConfigurationRestore(value: ClientConfigurationPlanDto) {
    return { clientId: value.clientId, state: 'not-configured' as const, configuredModels: [] };
  }
  close() { this.closed = true; }
}

test('desktop service validates input, forwards redacted plans and closes IPC clients', async () => {
  const clients: FakeClient[] = [];
  const service = new ClientConfigurationDesktopService({
    ipcPath: '/tmp/wrenyard.sock',
    clientFactory: () => {
      const client = new FakeClient();
      clients.push(client);
      return client;
    },
  });
  const preview = await service.plan('codex-shared', { models: ['openai/sol'], defaultModel: 'openai/sol' });
  assert.deepEqual(preview, plan);
  assert.equal(JSON.stringify(preview).includes('token'), false);
  assert.equal(clients[0].closed, true);
  await service.apply(preview);
  assert.equal(clients[1].closed, true);
  const restore = await service.planRestore('codex-shared');
  await service.restore(restore);
  assert.equal(clients.every((client) => client.closed), true);
});

test('desktop service rejects invalid clients and selections before IPC', async () => {
  let created = 0;
  const service = new ClientConfigurationDesktopService({
    ipcPath: '/tmp/wrenyard.sock',
    clientFactory: () => { created += 1; return new FakeClient(); },
  });
  await assert.rejects(() => service.plan('unknown', { models: ['m'], defaultModel: 'm' }), /类型无效/);
  await assert.rejects(() => service.plan('grok-build', { models: ['m', 'm'], defaultModel: 'm' }), /唯一模型/);
  assert.equal(created, 0);
});
