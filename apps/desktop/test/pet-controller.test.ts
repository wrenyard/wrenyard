import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '@wrenyard/pet/config';
import {
  DesktopPetController,
  type DesktopPetRuntimeHandle,
} from '../src/pet-controller.js';

function fixtureConfig(): AppConfig {
  return {
    enabled: true,
    scale: 3,
    bubbleSeconds: 6,
    bottomOffset: 0,
    house: { displayId: 1, entityX: 20, entityY: 30 },
    entities: { house: true, workers: true, taskgraphs: true },
    appearance: { houseSkin: 'classic' },
    quota: { providers: [{ id: 'chatgpt', enabled: true }] },
    windows: { graphSlip: { x: 1, y: 2 } },
  };
}

function runtime(events: string[]): DesktopPetRuntimeHandle {
  let status: DesktopPetRuntimeHandle['status'] = 'stopped';
  return {
    get status() { return status; },
    async start() {
      events.push('start');
      status = 'running';
    },
    async stop() {
      events.push('stop');
      status = 'stopped';
    },
    setQuotaProviders(providers) {
      events.push(`quota:${providers.map((provider) => provider.id).join(',')}`);
    },
  };
}

test('Desktop Pet controller owns runtime startup and exposes display state', async () => {
  const events: string[] = [];
  const controller = new DesktopPetController({
    loadConfig: fixtureConfig,
    saveConfig: () => undefined,
    createRuntime: () => runtime(events),
    listDisplays: () => [{ id: 1, label: 'Built-in Display', isPrimary: true }],
  });
  await controller.start();

  assert.deepEqual(controller.snapshot(), {
    status: 'running',
    settings: {
      enabled: true,
      displayId: 1,
      scale: 3,
      bubbleSeconds: 6,
      bottomOffset: 0,
      entities: { house: true, workers: true, taskgraphs: true },
      appearance: { houseSkin: 'classic' },
      quota: { providers: [{ id: 'chatgpt', enabled: true }] },
    },
    displays: [{ id: 1, label: 'Built-in Display', isPrimary: true }],
  });
  assert.deepEqual(events, ['start', 'quota:']);
});

test('Desktop Pet controller hides runtime-specific and legacy provider ids from product settings', async () => {
  const config = fixtureConfig();
  config.quota.providers = [
    { id: 'codebuddy-ioa', enabled: false },
    { id: 'codebuddy', enabled: true },
    { id: 'xai', enabled: true },
  ];
  const controller = new DesktopPetController({
    loadConfig: () => config,
    saveConfig: () => undefined,
    createRuntime: () => runtime([]),
  });

  assert.deepEqual(controller.snapshot().settings.quota.providers, [
    { id: 'codebuddy', enabled: true },
    { id: 'spacex-ai', enabled: true },
  ]);
  assert.equal(JSON.stringify(controller.snapshot()).toLowerCase().includes('ioa'), false);
  assert.equal(JSON.stringify(controller.snapshot()).includes('"xai"'), false);
});

test('Desktop persists changed Pet settings and restarts its in-process runtime', async () => {
  let current = fixtureConfig();
  const events: string[] = [];
  const controller = new DesktopPetController({
    loadConfig: () => current,
    saveConfig: (config) => { current = config; },
    createRuntime: () => runtime(events),
  });
  await controller.start();

  await controller.saveSettings({
    enabled: true,
    displayId: 1,
    scale: 4,
    bubbleSeconds: 8,
    bottomOffset: 12,
    entities: { house: true, workers: false, taskgraphs: true },
    appearance: { houseSkin: 'mushroom' },
    quota: { providers: [{ id: 'chatgpt', enabled: false }] },
  });

  assert.equal(current.scale, 4);
  assert.equal(current.entities.workers, false);
  assert.equal(current.appearance.houseSkin, 'mushroom');
  assert.deepEqual(current.house, { displayId: 1, entityX: 20, entityY: 30 });
  assert.deepEqual(current.windows, { graphSlip: { x: 1, y: 2 } });
  assert.deepEqual(events, ['start', 'quota:', 'stop', 'start', 'quota:']);
});

test('Desktop display selection resets only persisted Pet placement', async () => {
  let current = fixtureConfig();
  const events: string[] = [];
  const controller = new DesktopPetController({
    loadConfig: () => current,
    saveConfig: (config) => { current = config; },
    createRuntime: () => runtime(events),
  });
  await controller.start();

  await controller.selectDisplay(7);

  assert.deepEqual(current.house, { displayId: 7 });
  assert.deepEqual(events, ['start', 'quota:', 'stop', 'start', 'quota:']);
});

test('Desktop provider ordering retires legacy enablement and activates newly discovered providers', async () => {
  let current = fixtureConfig();
  current.quota.providers.push({ id: 'cursor', enabled: false });
  const events: string[] = [];
  const controller = new DesktopPetController({
    loadConfig: () => current,
    saveConfig: (config) => { current = config; },
    createRuntime: () => runtime(events),
  });
  await controller.start();

  await controller.saveProviderOrder(['cursor', 'anthropic', 'chatgpt']);

  assert.deepEqual(current.quota.providers, [
    { id: 'cursor', enabled: true },
    { id: 'anthropic', enabled: true },
    { id: 'chatgpt', enabled: true },
  ]);
  assert.deepEqual(events, ['start', 'quota:']);
});

test('disabling the Desktop Pet stops it without starting a replacement runtime', async () => {
  let current = fixtureConfig();
  const events: string[] = [];
  const controller = new DesktopPetController({
    loadConfig: () => current,
    saveConfig: (config) => { current = config; },
    createRuntime: () => runtime(events),
  });
  await controller.start();
  await controller.setEnabled(false);

  assert.equal(current.enabled, false);
  assert.equal(controller.snapshot().status, 'stopped');
  assert.deepEqual(events, ['start', 'quota:', 'stop']);
});

test('Desktop projects one quota refresh into the active Pet runtime', async () => {
  const events: string[] = [];
  const controller = new DesktopPetController({
    loadConfig: fixtureConfig,
    saveConfig: () => undefined,
    createRuntime: () => runtime(events),
  });
  controller.setQuotaProviders([{ id: 'chatgpt' } as never, { id: 'cursor' } as never]);
  await controller.start();

  assert.deepEqual(events, ['start', 'quota:chatgpt,cursor']);
});
