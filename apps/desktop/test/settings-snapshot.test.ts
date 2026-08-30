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
    readHealth: async () => ({ connected: true, uptimeMs: 125_000 }),
    readCredentialEnv: async () => ({
      FORGE_DSH_KIMI_CODING_API_KEY: 'fixture-credential-value',
    }),
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
  assert.deepEqual(snapshot.models.slice(0, 2), [
    { id: 'kimi-coding', label: 'Kimi Coding', configured: true },
    { id: 'zhipu-coding', label: 'Zhipu Coding', configured: false },
  ]);
  assert.equal(snapshot.models.length, 11);
  for (const id of ['openai', 'zhipu', 'moonshot', 'minimax', 'minimax-coding', 'qwen', 'qwen-coding', 'tokenhub', 'volcengine']) {
    assert.equal(snapshot.models.find((provider) => provider.id === id)?.configured, false);
  }
  assert.deepEqual(snapshot.pet, pet);
  assert.equal(snapshot.update.channel, 'dev');
  assert.equal(JSON.stringify(snapshot).includes('fixture-credential-value'), false);
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
    readCredentialEnv: async () => {
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
  assert.ok(snapshot.models.every((model) => model.configured === false));
});
