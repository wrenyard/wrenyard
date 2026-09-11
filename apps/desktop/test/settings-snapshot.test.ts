import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSettingsSnapshot } from '../src/settings-snapshot.js';

const pet = {
  status: 'running' as const,
  settings: {
    enabled: true,
    displayId: 1,
    scale: 3,
    bubbleSeconds: 6,
    bottomOffset: 0,
    entities: { house: true, workers: true, taskgraphs: true },
    appearance: { houseSkin: 'classic' as const },
    quota: { providers: [{ id: 'codex', enabled: true }] },
  },
  displays: [{ id: 1, label: 'Built-in Display', isPrimary: true }],
};

test('settings snapshot exposes health and credential presence without secrets', async () => {
  const snapshot = await buildSettingsSnapshot({
    endpoint: '/tmp/wrenyard.sock',
    workspace: {
      status: 'configured',
      source: 'user-config',
      configPath: '/config/wrenyard.json',
      path: '/workspace/wrenyard',
      readOnly: false,
    },
    desktopVersion: '1.0.0-dev.14',
    wrenyardVersion: '1.0.0-dev.14',
    dshVersion: '0.1.0-rc.6',
    buildTime: '2026-09-01T02:03:04.000Z',
    readHealth: async () => ({ connected: true, uptimeMs: 125_000 }),
    readGatewayModels: async () => [
      { id: 'k3', publicId: 'kimi-coding/k3', provider: 'kimi-coding', displayName: 'Kimi K3', intelligence: 'high' },
      { id: 'glm-5.3', publicId: 'zhipu-coding/glm-5.3', provider: 'zhipu-coding', displayName: 'GLM 5.3', intelligence: 'high' },
      { id: 'glm-5.3-flash', publicId: 'zhipu-coding/glm-5.3-flash', provider: 'zhipu-coding', displayName: 'GLM 5.3 Flash', intelligence: 'mid' },
    ],
    readPet: async () => pet,
    readUpdate: () => ({
      channel: 'dev',
      state: 'up-to-date',
      currentVersion: '1.0.0-dev.14',
      installSupported: true,
    }),
  });

  assert.deepEqual(snapshot.service, {
    status: 'connected',
    endpoint: '/tmp/wrenyard.sock',
    workspace: {
      status: 'configured',
      source: 'user-config',
      configPath: '/config/wrenyard.json',
      path: '/workspace/wrenyard',
      readOnly: false,
    },
    uptimeMs: 125_000,
  });
  assert.deepEqual(snapshot.models, [
    { id: 'kimi-coding', label: 'kimi-coding', configured: true },
    { id: 'zhipu-coding', label: 'zhipu-coding', configured: true },
  ]);
  assert.deepEqual(snapshot.pet, pet);
  assert.equal(snapshot.update.channel, 'dev');
  assert.deepEqual(snapshot.about, {
    desktopVersion: '1.0.0-dev.14',
    wrenyardVersion: '1.0.0-dev.14',
    dshVersion: '0.1.0-rc.6',
    buildTime: '2026-09-01T02:03:04.000Z',
    channel: 'dev',
  });
  assert.equal(JSON.stringify(snapshot).includes('token'), false);
});

test('settings snapshot degrades health and credentials independently', async () => {
  const snapshot = await buildSettingsSnapshot({
    endpoint: '/tmp/wrenyard.sock',
    workspace: {
      status: 'missing',
      source: 'none',
      configPath: '/config/wrenyard.json',
      readOnly: false,
    },
    desktopVersion: '1.0.0-dev.14',
    wrenyardVersion: '1.0.0-dev.14',
    dshVersion: '0.1.0-rc.6',
    readHealth: async () => {
      throw new Error('offline');
    },
    readGatewayModels: async () => {
      throw new Error('unreadable');
    },
    readPet: async () => pet,
    readUpdate: () => ({
      channel: 'stable',
      state: 'idle',
      currentVersion: '1.0.0',
      installSupported: true,
    }),
  });

  assert.equal(snapshot.service.status, 'unavailable');
  assert.deepEqual(snapshot.models, []);
  assert.equal('buildTime' in snapshot.about, false);
});
