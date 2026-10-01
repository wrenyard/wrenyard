import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DesktopSettingsStore,
  defaultDesktopSettings,
  type DesktopSettings,
} from '../src/main/settings/desktop-settings.js';
import {
  DesktopPetController,
  type DesktopPetRuntimeHandle,
} from '../src/pet/main/pet-controller.js';

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
    setVisible(visible) {
      events.push(`visible:${visible}`);
    },
    setQuotaProviders(providers) {
      events.push(`quota:${providers.map((provider) => provider.id).join(',')}`);
    },
  };
}

function withStoreSettings(
  settings: Partial<DesktopSettings>,
  run: (store: DesktopSettingsStore) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-desktop-pet-'));
  const store = new DesktopSettingsStore({ path: join(root, 'settings.json') });
  store.save({ ...defaultDesktopSettings(), ...settings });
  return run(store).finally(() => rmSync(root, { recursive: true, force: true }));
}

test('Desktop Pet controller owns runtime startup and exposes display state', async () => {
  await withStoreSettings({
    pet: { ...defaultDesktopSettings().pet, displayId: 1 },
    providers: { providers: [{ id: 'chatgpt', enabled: true }] },
    window: { graphSlip: { x: 1, y: 2 } },
  }, async (store) => {
    const events: string[] = [];
    const controller = new DesktopPetController({
      store,
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
    assert.deepEqual(events, ['start', 'visible:true', 'quota:']);
  });
});

test('Pet visibility toggles keep the mounted runtime and its subscriptions', async () => {
  await withStoreSettings({}, async (store) => {
    const events: string[] = [];
    const controller = new DesktopPetController({
      store,
      createRuntime: () => runtime(events),
    });
    await controller.start();

    await controller.setVisible(false);

    assert.equal(store.load().pet.visible, false);
    assert.equal(controller.snapshot().status, 'running');
    assert.deepEqual(events, ['start', 'visible:true', 'quota:', 'visible:false']);

    await controller.setVisible(true);

    assert.equal(store.load().pet.visible, true);
    assert.equal(controller.snapshot().status, 'running');
    // Re-showing resumes the same runtime instead of creating a new one.
    assert.deepEqual(events, ['start', 'visible:true', 'quota:', 'visible:false', 'visible:true']);
  });
});

test('a structural Pet settings change rebuilds the runtime', async () => {
  await withStoreSettings({
    pet: { ...defaultDesktopSettings().pet, displayId: 1 },
  }, async (store) => {
    const events: string[] = [];
    const controller = new DesktopPetController({
      store,
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
      quota: { providers: [{ id: 'chatgpt', enabled: true }] },
    });

    const pet = store.load().pet;
    assert.equal(pet.visible, true);
    assert.equal(pet.scale, 4);
    assert.equal(pet.bubbleSeconds, 8);
    assert.equal(pet.bottomOffset, 12);
    assert.equal(pet.entities.workers, false);
    assert.equal(pet.appearance.houseSkin, 'mushroom');
    assert.deepEqual(events, ['start', 'visible:true', 'quota:', 'stop', 'start', 'visible:true', 'quota:']);
  });
});

test('Desktop projects one quota refresh into the active Pet runtime', async () => {
  await withStoreSettings({}, async (store) => {
    const events: string[] = [];
    const controller = new DesktopPetController({
      store,
      createRuntime: () => runtime(events),
    });
    controller.setQuotaProviders([{ id: 'chatgpt' } as never, { id: 'cursor' } as never]);
    await controller.start();

    assert.deepEqual(events, ['start', 'visible:true', 'quota:chatgpt,cursor']);
  });
});
