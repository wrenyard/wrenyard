import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SETTINGS_VERSION,
  convertFile,
  convertSettingsDocument,
} from './convert-settings.mjs';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-convert-settings-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LEGACY_PET_CONFIG = {
  enabled: false,
  scale: 4,
  bubbleSeconds: 9,
  bottomOffset: 12,
  house: { displayId: 5, x: -20, y: 30, entityX: 0, entityY: 900 },
  entities: { house: true, workers: false, taskgraphs: true },
  appearance: { houseSkin: 'mushroom' },
  quota: { providers: [{ id: 'codex', enabled: false }, { id: 'kimi-coding', enabled: true }] },
  windows: { graphSlip: { x: 40, y: 60, width: 480, height: 640, ignored: true } },
};

test('a raw legacy Pet config becomes the version 2 Pet partition', () => {
  const { document, warnings } = convertSettingsDocument(LEGACY_PET_CONFIG, 'legacy.json');

  assert.equal(document.version, SETTINGS_VERSION);
  assert.deepEqual(document.pet, {
    visible: false,
    displayId: 5,
    scale: 4,
    bubbleSeconds: 9,
    bottomOffset: 12,
    entities: { house: true, workers: false, taskgraphs: true },
    appearance: { houseSkin: 'mushroom' },
    layout: { entityX: 0, entityY: 900 },
  });
  assert.deepEqual(document.providers.providers, [
    { id: 'codex', enabled: false },
    { id: 'kimi-coding', enabled: true },
  ]);
  assert.deepEqual(document.window.graphSlip, { x: 40, y: 60, width: 480, height: 640 });
  assert.equal(warnings.some((warning) => warning.includes('house.x/y')), true);
});

test('a version 1 Desktop document keeps its shell sections', () => {
  const { document } = convertSettingsDocument({
    version: 1,
    pet: { enabled: true, scale: 3, entities: { house: true, workers: true, taskgraphs: false } },
  }, 'settings.json');

  assert.equal(document.version, SETTINGS_VERSION);
  assert.equal(document.pet.visible, true);
  assert.equal(document.pet.scale, 3);
  assert.deepEqual(document.pet.entities, { house: true, workers: true, taskgraphs: false });
  assert.deepEqual(document.window, {});
  assert.deepEqual(document.tray, {});
});

test('legacy quota.pools is promoted to provider rows in order', () => {
  const { document } = convertSettingsDocument({
    quota: { pools: ['chatgpt', 'anthropic', 'chatgpt'] },
  }, 'legacy.json');

  assert.deepEqual(document.providers.providers, [
    { id: 'chatgpt', enabled: true },
    { id: 'anthropic', enabled: true },
  ]);
});

test('an already converted document is flagged and rejected unless forced', () => {
  const { alreadyVersion2 } = convertSettingsDocument(
    { version: SETTINGS_VERSION, pet: { enabled: true } },
    'settings.json',
  );
  assert.equal(alreadyVersion2, true);

  withTempDir((dir) => {
    const input = join(dir, 'settings.json');
    writeFileSync(input, JSON.stringify({ version: SETTINGS_VERSION, pet: {} }), 'utf8');
    assert.throws(() => convertFile({ input, output: input }), /already a version 2 document/);
    const forced = convertFile({ input, output: input, force: true });
    assert.equal(forced.document.version, SETTINGS_VERSION);
  });
});

test('every existing file is backed up exclusively before writing', () => {
  withTempDir((dir) => {
    const input = join(dir, 'legacy.json');
    const output = join(dir, 'settings.json');
    writeFileSync(input, JSON.stringify(LEGACY_PET_CONFIG), 'utf8');
    writeFileSync(output, JSON.stringify({ version: 1, pet: { enabled: true } }), 'utf8');

    const first = convertFile({ input, output });
    assert.equal(first.backups.length, 2);
    const second = convertFile({ input, output });

    const backups = readdirSync(dir).filter((name) => name.includes('.bak'));
    assert.equal(backups.length, 4);
    // Exclusive creation: no earlier rollback copy was overwritten.
    assert.equal(new Set(first.backups).size, 2);
    assert.notDeepEqual(first.backups, second.backups);
    const written = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(written.version, SETTINGS_VERSION);
    assert.equal(written.pet.visible, false);
  });
});
