import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertFullStagedRuntime, expectedArtifactNames } from './pack.mjs';

test('expectedArtifactNames covers darwin, windows and linux-x64 AppImage', () => {
  const version = '1.2.3';
  assert.deepEqual(expectedArtifactNames(version, 'darwin-arm64'), [
    `wrenyard-desktop-${version}-darwin-arm64.dmg`,
    `wrenyard-desktop-${version}-darwin-arm64.zip`,
  ]);
  assert.deepEqual(expectedArtifactNames(version, 'win32-x64'), [
    `wrenyard-desktop-${version}-win32-x64-setup.exe`,
  ]);
  assert.deepEqual(expectedArtifactNames(version, 'linux-x64'), [
    `wrenyard-desktop-${version}-linux-x64.AppImage`,
  ]);
});

test('assertFullStagedRuntime forbids a .pack-stub placeholder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-pack-stub-'));
  try {
    writeFileSync(join(dir, 'wrenyard'), 'sea');
    assertFullStagedRuntime(dir, 'resources/wrenyard');
    writeFileSync(join(dir, '.pack-stub'), 'stub\n');
    assert.throws(
      () => assertFullStagedRuntime(dir, 'resources/wrenyard'),
      /\.pack-stub/,
    );
    const missing = join(dir, 'missing');
    assert.throws(() => assertFullStagedRuntime(missing, 'resources/wrenyard'), /full staged runtime directory/);
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'nope');
    assert.throws(() => assertFullStagedRuntime(file, 'resources/wrenyard'), /full staged runtime directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory without .pack-stub is accepted as a full stage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-pack-full-'));
  try {
    mkdirSync(join(dir, 'daemon'), { recursive: true });
    writeFileSync(join(dir, 'wrenyard'), 'sea');
    assertFullStagedRuntime(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
