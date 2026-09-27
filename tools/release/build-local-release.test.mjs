import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  artifactNames,
  assertNoSymlinks,
  assertSingleSuiteMarker,
  assertSuitePathLengths,
  writeSidecar,
} from './build-local-release.mjs';

function withStage(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-build-output-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFile(root, rel, contents = '') {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function linkFile(target, link) {
  try {
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, 'file');
    return true;
  } catch {
    return false;
  }
}

test('the suite archive contract is exactly two zips and two sidecars', () => {
  const names = artifactNames('1.2.3-dev.4', 'darwin-arm64');
  assert.equal(names.suite, 'wrenyard-1.2.3-dev.4-darwin-arm64-suite.zip');
  assert.equal(names.desktop, 'wrenyard-desktop-1.2.3-dev.4-darwin-arm64.zip');
  const zips = [names.suite, names.desktop].filter(Boolean);
  assert.equal(zips.length, 2);
  assert.equal(zips.map((name) => `${name}.sha256`).length, 2);
  const skipped = artifactNames('1.2.3-dev.4', 'darwin-arm64', true);
  assert.equal(skipped.desktop, null);
  assert.equal([skipped.suite, skipped.desktop].filter(Boolean).length, 1);
});

test('writeSidecar writes a sha256 sidecar next to the archive', () => {
  withStage((stage) => {
    const zip = writeFile(stage, 'wrenyard-1.2.3-dev.4-darwin-arm64-suite.zip', 'payload');
    writeSidecar(zip);
    const sidecar = `${zip}.sha256`;
    assert.ok(existsSync(sidecar));
    assert.match(readFileSync(sidecar, 'utf8'), /^[0-9a-f]{64}  wrenyard-1\.2\.3-dev\.4-darwin-arm64-suite\.zip\n$/);
  });
});

test('symlinks anywhere in the suite are rejected', () => {
  withStage((stage) => {
    writeFile(stage, 'runtime/node', 'binary');
    assert.doesNotThrow(() => assertNoSymlinks(stage, 'suite'));
    if (!linkFile('runtime/node', join(stage, 'wrenyard-link'))) return; // unsupported on this host
    assert.throws(() => assertNoSymlinks(stage, 'suite'), /suite tree contains symlinks/);
  });
});

test('the suite root marker must appear exactly once', () => {
  withStage((stage) => {
    assert.throws(() => assertSingleSuiteMarker(stage), /exactly one contracts\/versions\.json/);
    writeFile(stage, 'contracts/versions.json', '{}\n');
    assert.doesNotThrow(() => assertSingleSuiteMarker(stage));
    writeFile(stage, 'apps/cli/node_modules/dep/contracts/versions.json', '{}\n');
    assert.throws(() => assertSingleSuiteMarker(stage), /exactly one contracts\/versions\.json/);
  });
});

test('relative paths longer than the limit are rejected', () => {
  withStage((stage) => {
    writeFile(stage, join('runtime', 'node'), 'binary');
    assert.doesNotThrow(() => assertSuitePathLengths(stage));
    writeFile(stage, join('apps', 'cli', 'node_modules', 'x'.repeat(40), 'file.js'), 'x');
    assert.throws(() => assertSuitePathLengths(stage, 20), /exceeds 20 characters/);
  });
});
