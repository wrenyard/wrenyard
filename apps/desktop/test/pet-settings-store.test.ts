import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalizeConfig, type AppConfig } from '@wrenyard/pet/config';
import { DesktopPetSettingsStore } from '../src/pet-settings-store.js';

function fixtureConfig(): AppConfig {
  return {
    enabled: true,
    scale: 3,
    bubbleSeconds: 6,
    bottomOffset: 0,
    house: { displayId: 5, entityX: 20, entityY: 30 },
    entities: { house: true, workers: true, taskgraphs: true },
    appearance: { houseSkin: 'classic' },
    quota: { providers: [{ id: 'codex', enabled: true }] },
    windows: { graphSlip: { x: 1, y: 2 } },
  };
}

test('Desktop imports legacy Pet config once into its own versioned settings file', () => {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-desktop-settings-'));
  try {
    const path = join(root, 'nested', 'settings.json');
    let legacyReads = 0;
    const store = new DesktopPetSettingsStore({
      path,
      loadLegacy: () => {
        legacyReads += 1;
        return fixtureConfig();
      },
    });

    const imported = store.load();
    assert.equal(imported.house.displayId, 5);
    assert.equal(imported.enabled, true);
    assert.equal(legacyReads, 1);
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as { version: number; pet: AppConfig };
    assert.equal(persisted.version, 1);
    assert.deepEqual(normalizeConfig(persisted.pet), imported);

    const second = new DesktopPetSettingsStore({
      path,
      loadLegacy: () => { throw new Error('legacy config must not be read twice'); },
    });
    assert.deepEqual(second.load(), imported);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Desktop settings store normalizes an older unwrapped Pet document', () => {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-desktop-settings-'));
  try {
    const path = join(root, 'settings.json');
    writeFileSync(path, JSON.stringify({ scale: 99, entities: { house: false } }), 'utf8');
    const store = new DesktopPetSettingsStore({ path, loadLegacy: fixtureConfig });
    const loaded = store.load();
    assert.equal(loaded.enabled, true);
    assert.equal(loaded.scale, 3);
    assert.equal(loaded.entities.house, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Desktop settings store preserves Pet and update channel in one document', () => {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-desktop-settings-'));
  try {
    const path = join(root, 'settings.json');
    const store = new DesktopPetSettingsStore({ path, loadLegacy: fixtureConfig });
    store.save(fixtureConfig());
    assert.equal(store.loadUpdateChannel('dev'), 'dev');

    store.saveUpdateChannel('stable');
    assert.equal(store.loadUpdateChannel('dev'), 'stable');
    assert.equal(store.load().house.displayId, 5);

    const changed = { ...store.load(), scale: 4 };
    store.save(changed);
    assert.equal(store.loadUpdateChannel('dev'), 'stable');
    assert.equal(store.load().scale, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
