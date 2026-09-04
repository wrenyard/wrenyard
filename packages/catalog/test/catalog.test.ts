import assert from 'node:assert/strict';
import test from 'node:test';
import { Catalog } from '../src/index.ts';

test('native routing wins over a shared gateway protocol', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'native', gatewayProtocols: ['openai_chat'] });
  catalog.registerProvider({
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'forge-managed',
    nativeClients: ['native'], models: [{ id: 'm', displayName: 'M' }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://example.com/v1/chat/completions', authScheme: 'bearer' }],
  });
  assert.equal(catalog.resolveRun('native', 'vendor', 'm').mode, 'native');
});

test('gateway models use provider/model ids and resolve to an exact dispatch plan', () => {
  const catalog = new Catalog();
  catalog.registerClient({ id: 'client', gatewayProtocols: ['openai_chat'] });
  catalog.registerProvider({
    id: 'vendor', displayName: 'Vendor', credentialResolver: 'forge-managed',
    models: [{ id: 'm', displayName: 'M' }],
    protocols: [{ protocol: 'openai_chat', endpoint: 'https://secret.example/v1/chat/completions', authScheme: 'bearer' }],
  });
  assert.equal(catalog.listGatewayModels('openai_chat')[0]?.publicId, 'vendor/m');
  assert.deepEqual(catalog.resolveRun('client', 'vendor', 'm'), {
    client: 'client', provider: 'vendor', model: 'm', mode: 'gateway', protocol: 'openai_chat',
  });
});
