import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildSettingsSnapshot } from '../src/settings-snapshot.js';
import { DesktopSettingsStore, defaultDesktopSettings } from '../src/main/settings/desktop-settings.js';

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
    buildTime: '2026-09-01T02:03:04.000Z',
    readHealth: async () => ({ connected: true, runtimeMode: 'source', uptimeMs: 125_000 }),
    readGatewayModels: async () => [
      { id: 'k3', publicId: 'kimi-coding/k3', provider: 'kimi-coding', displayName: 'Kimi K3', intelligence: 'high' },
      { id: 'glm-5.3', publicId: 'zhipu-coding/glm-5.3', provider: 'zhipu-coding', displayName: 'GLM 5.3', intelligence: 'high' },
      { id: 'glm-5.3-flash', publicId: 'zhipu-coding/glm-5.3-flash', provider: 'zhipu-coding', displayName: 'GLM 5.3 Flash', intelligence: 'mid' },
    ],
    readPet: async () => pet,
    readUpdate: () => ({
      state: 'up-to-date',
      currentVersion: '1.0.0-dev.14',
      installSupported: true,
    }),
  });

  assert.equal(snapshot.service.status, 'connected');
  assert.equal(snapshot.service.runtimeMode, 'source');
  assert.equal(snapshot.service.uptimeMs, 125_000);
  assert.equal('sourceDevelopment' in snapshot.about, false);
  assert.deepEqual(snapshot.models, [
    { id: 'kimi-coding', label: 'kimi-coding', configured: true },
    { id: 'zhipu-coding', label: 'zhipu-coding', configured: true },
  ]);
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
    readHealth: async () => {
      throw new Error('offline');
    },
    readGatewayModels: async () => {
      throw new Error('unreadable');
    },
    readPet: async () => pet,
    readUpdate: () => ({
      state: 'idle',
      currentVersion: '1.0.0',
      installSupported: true,
    }),
  });

  assert.equal(snapshot.service.status, 'unavailable');
  assert.equal('runtimeMode' in snapshot.service, false);
  assert.deepEqual(snapshot.models, []);
  assert.equal('buildTime' in snapshot.about, false);
});

test('an unrelated settings write preserves opaque session keys without consuming them', () => {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-session-preserve-'));
  const path = join(root, 'settings.json');
  try {
    // A raw version 3 document still carrying retired session keys exactly as an
    // older build may have left them on disk.
    const raw = `${JSON.stringify({
      ...defaultDesktopSettings(),
      session: {
        defaultModel: 'last',
        model: 'a/b',
        effort: null,
        lastSentModel: 'a/b',
        lastSentEffort: 'high',
        sendKey: 'mod-enter',
      },
    }, null, 2)}\n`;
    writeFileSync(path, raw, 'utf8');
    const store = new DesktopSettingsStore({ path });

    // The normalized, renderer-facing view exposes only the live submit key.
    const loaded = store.load();
    assert.deepEqual(loaded.session, { sendKey: 'mod-enter' });

    // An unrelated partition write keeps every retired key on disk untouched.
    store.patch('appearance', { ...loaded.appearance, colorMode: 'dark' });
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as {
      appearance: { colorMode: string };
      session: Record<string, unknown>;
    };
    assert.equal(persisted.appearance.colorMode, 'dark');
    assert.deepEqual(persisted.session, {
      defaultModel: 'last',
      model: 'a/b',
      effort: null,
      lastSentModel: 'a/b',
      lastSentEffort: 'high',
      sendKey: 'mod-enter',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
