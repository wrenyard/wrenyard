import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameGatewayIdentity } from '../src/service-recovery.js';

// WrenyardGatewayConnection-shaped fixtures kept structural on purpose so this
// file stays Electron-free and never serializes the connection token.
interface GatewayConnectionFixture {
  token: string;
  endpoints: Record<string, string>;
  models: string[];
}

const connectionTokenA = 'gtw_connection_token_a';
const connectionTokenB = 'gtw_connection_token_b';
const defaultEndpoints = {
  api: 'https://gw.restricted.example.test/v1',
  events: 'https://gw.restricted.example.test/events',
};
const defaultModels = ['model-alpha', 'model-beta', 'model-gamma'];

function connectionFixture(overrides: Partial<GatewayConnectionFixture> = {}): GatewayConnectionFixture {
  return {
    token: connectionTokenA,
    endpoints: { ...defaultEndpoints },
    models: [...defaultModels],
    ...overrides,
  };
}

test('identical gateway connections share an identity', () => {
  const left = connectionFixture();
  const right = connectionFixture();
  assert.equal(sameGatewayIdentity(left, right), true);
});

test('gateway identity is equal when model identities match in a different order', () => {
  const left = connectionFixture();
  const right = connectionFixture({ models: [...defaultModels].reverse() });
  assert.equal(sameGatewayIdentity(left, right), true);
});

test('a different token changes the gateway identity', () => {
  const left = connectionFixture();
  const right = connectionFixture({ token: connectionTokenB });
  assert.equal(sameGatewayIdentity(left, right), false);
});

test('changing any endpoint changes the gateway identity', () => {
  const left = connectionFixture();
  const changedApi = connectionFixture({
    endpoints: { ...defaultEndpoints, api: 'https://gw.restricted.example.test/v2' },
  });
  const changedEvents = connectionFixture({
    endpoints: { ...defaultEndpoints, events: 'https://gw.restricted.example.test/v2-events' },
  });
  assert.equal(sameGatewayIdentity(left, changedApi), false);
  assert.equal(sameGatewayIdentity(left, changedEvents), false);
});

test('changing a model identity changes the gateway identity', () => {
  const left = connectionFixture();
  const right = connectionFixture({ models: [...defaultModels.slice(0, -1), 'model-delta'] });
  assert.equal(sameGatewayIdentity(left, right), false);
});

test('gateway identity comparison is symmetric', () => {
  const left = connectionFixture({ endpoints: { ...defaultEndpoints, api: 'https://gw.restricted.example.test/v2' } });
  const right = connectionFixture();
  assert.equal(sameGatewayIdentity(left, right), false);
  assert.equal(sameGatewayIdentity(right, left), false);
});
