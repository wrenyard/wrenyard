import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DESKTOP_SETTINGS_VERSION,
  DesktopSettingsCorruptError,
  DesktopSettingsStore,
  configFromPetSettings,
  defaultDesktopSettings,
  petSettingsFromConfig,
} from '../src/main/settings/desktop-settings.js';
import type { DesktopSettings } from '../src/main/settings/desktop-settings.js';

function withTempStore(run: (path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-desktop-settings-'));
  try {
    run(join(root, 'nested', 'settings.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function version2Document(overrides: Partial<DesktopSettings> = {}): DesktopSettings {
  return { ...defaultDesktopSettings(), ...overrides };
}

test('missing settings file yields defaults without writing a document', () => {
  withTempStore((path) => {
    const store = new DesktopSettingsStore({ path });
    assert.deepEqual(store.load(), defaultDesktopSettings());
    assert.equal(existsSync(path), false);
  });
});

test('a section patch preserves every other section of the document', () => {
  withTempStore((path) => {
    const store = new DesktopSettingsStore({ path });
    store.save(version2Document({
      window: { shell: { x: 10, y: 20, width: 900, height: 600 } },
      providers: { providers: [{ id: 'chatgpt', enabled: true }, { id: 'kimi-coding', enabled: false }] },
      update: { channel: 'dev' },
    }));

    store.patch('pet', { ...store.load().pet, visible: false, scale: 5 });

    const persisted = JSON.parse(readFileSync(path, 'utf8')) as DesktopSettings;
    assert.equal(persisted.version, DESKTOP_SETTINGS_VERSION);
    assert.equal(persisted.pet.visible, false);
    assert.equal(persisted.pet.scale, 5);
    assert.deepEqual(persisted.providers.providers, [
      { id: 'chatgpt', enabled: true },
      { id: 'kimi-coding', enabled: false },
    ]);
    assert.deepEqual(persisted.window.shell, { x: 10, y: 20, width: 900, height: 600 });
    assert.equal(persisted.update.channel, 'dev');
  });
});

test('update channel reads and writes only the update partition', () => {
  withTempStore((path) => {
    const store = new DesktopSettingsStore({ path });
    assert.equal(store.loadUpdateChannel('stable'), 'stable');

    store.save(version2Document({
      pet: { ...defaultDesktopSettings().pet, visible: false, scale: 4 },
    }));
    store.saveUpdateChannel('dev');

    assert.equal(store.loadUpdateChannel('stable'), 'dev');
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as DesktopSettings;
    assert.equal(persisted.update.channel, 'dev');
    assert.equal(persisted.pet.visible, false);
    assert.equal(persisted.pet.scale, 4);
  });
});

test('an unparsable document raises and is never replaced with defaults', () => {
  withTempStore((path) => {
    writeFileSync(path, '{ not json', 'utf8');
    const before = readFileSync(path, 'utf8');
    const store = new DesktopSettingsStore({ path });

    assert.throws(
      () => store.load(),
      (error: unknown) => error instanceof DesktopSettingsCorruptError && error.code === 'parse_failed',
    );
    assert.equal(readFileSync(path, 'utf8'), before);
  });
});

test('unknown or pre-version-2 documents are reported and preserved', () => {
  withTempStore((path) => {
    const legacy = `${JSON.stringify({ version: 1, pet: { enabled: false } }, null, 2)}\n`;
    writeFileSync(path, legacy, 'utf8');
    const store = new DesktopSettingsStore({ path });

    assert.throws(
      () => store.load(),
      (error: unknown) => error instanceof DesktopSettingsCorruptError && error.code === 'unsupported_version',
    );
    assert.equal(readFileSync(path, 'utf8'), legacy);

    const future = `${JSON.stringify({ version: 99 }, null, 2)}\n`;
    writeFileSync(path, future, 'utf8');
    const futureStore = new DesktopSettingsStore({ path });
    assert.throws(
      () => futureStore.load(),
      (error: unknown) => error instanceof DesktopSettingsCorruptError && error.code === 'unsupported_version',
    );
    assert.equal(readFileSync(path, 'utf8'), future);
  });
});

test('Pet settings project through the partition without losing provider order or channel', () => {
  withTempStore((path) => {
    const store = new DesktopSettingsStore({ path });
    store.save(version2Document({
      providers: { providers: [{ id: 'deepseek', enabled: false }, { id: 'chatgpt', enabled: true }] },
      update: { channel: 'dev' },
    }));
    const settings = store.load();

    const pet = petSettingsFromConfig(configFromPetSettings(
      { ...settings.pet, visible: false, scale: 2, entities: { house: false, workers: true, taskgraphs: false } },
      settings.providers.providers,
      settings.window.graphSlip,
    ));
    store.patch('pet', pet);

    const persisted = JSON.parse(readFileSync(path, 'utf8')) as DesktopSettings;
    assert.equal(persisted.pet.visible, false);
    assert.equal(persisted.pet.scale, 2);
    assert.deepEqual(persisted.pet.entities, { house: false, workers: true, taskgraphs: false });
    assert.deepEqual(persisted.providers.providers, [
      { id: 'deepseek', enabled: false },
      { id: 'chatgpt', enabled: true },
    ]);
    assert.equal(persisted.update.channel, 'dev');
  });
});
