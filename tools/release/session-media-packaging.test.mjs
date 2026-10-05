#!/usr/bin/env node
// Focused native-bundling check for session media packaging. It verifies the
// production sharp pin, that the daemon build keeps sharp external with an
// exact manifest entry, that `copyDependencyClosure` carries the installed
// @img native binding + libvips and that the copied closure can actually resize
// an image, that importing `pack.mjs` never runs a release, and that the narrow
// Desktop metadata-only bundle cannot pull sharp through the session barrel.
//
// It never packs, releases, publishes, installs, or restarts a daemon; the only
// work it performs is copying sharp into an OS temp dir and one esbuild bundle.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { copyDependencyClosure } from './pack.mjs';

const RELEASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(RELEASE_DIR, '..', '..');
const SESSION_DIR = path.join(ROOT, 'packages', 'features', 'session');
const DESKTOP_DIR = path.join(ROOT, 'apps', 'desktop');
const SHARP_VERSION = '0.35.4';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Nearest package directory for `name`, resolved from `fromFile` like Node.
function packageDir(name, fromFile) {
  const require = createRequire(fromFile);
  let dir = path.dirname(require.resolve(name));
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest) && readJson(manifest).name === name) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`cannot find package directory for ${name}`);
    dir = parent;
  }
}

function walkFiles(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(file, visit);
    else if (entry.isFile()) visit(file);
  }
}

test('session production pins sharp@0.35.4 and it is installed', () => {
  const manifest = readJson(path.join(SESSION_DIR, 'package.json'));
  assert.equal(manifest.dependencies.sharp, SHARP_VERSION, 'sharp is a production dependency');
  assert.equal(manifest.devDependencies?.sharp, undefined, 'sharp must not be a dev-only dependency');
  const sharpDir = packageDir('sharp', path.join(SESSION_DIR, 'package.json'));
  assert.equal(readJson(path.join(sharpDir, 'package.json')).version, SHARP_VERSION, 'the installed sharp matches the pin');
});

test('daemon build keeps sharp external and writes an exact manifest entry', () => {
  const source = fs.readFileSync(path.join(ROOT, 'apps', 'daemon', 'tools', 'build.mjs'), 'utf8');
  assert.match(source, /sharp:\s*session\.dependencies\.sharp/, 'sharp stays in the external map');
  assert.match(source, /external:\s*\[\.\.\.Object\.keys\(external\)/, 'the external list carries sharp');
  assert.match(
    source,
    /name === 'better-sqlite3' \? range : exact\(name, range\)/,
    'every non-sqlite external is pinned to the resolved exact version',
  );
});

test('copyDependencyClosure bundles sharp with native binaries and can resize', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrenyard-sharp-closure-'));
  try {
    const nodeModules = path.join(tmp, 'node_modules');
    copyDependencyClosure([['sharp', SESSION_DIR]], nodeModules);
    assert.equal(
      readJson(path.join(nodeModules, 'sharp', 'package.json')).version,
      SHARP_VERSION,
      'the copied manifest keeps the pinned version',
    );

    const nativeFiles = [];
    walkFiles(nodeModules, (file) => {
      if (file.endsWith('.node') || /(?:^|[/\\])libvips[^/\\]*\.(?:dylib|so|dll)$/u.test(file) || file.includes('sharp-libvips')) {
        nativeFiles.push(file);
      }
    });
    assert.ok(
      nativeFiles.some((file) => file.endsWith('.node') && /@img[/\\]sharp-/.test(file)),
      'the installed @img sharp native binding is copied',
    );
    assert.ok(nativeFiles.some((file) => file.includes('sharp-libvips') || path.basename(file).startsWith('libvips')), 'libvips is copied');

    // The copied closure must actually load and process an image, not just exist.
    const requireClosure = createRequire(path.join(tmp, 'closure-eval.cjs'));
    const sharp = requireClosure('sharp');
    const output = await sharp({ create: { width: 8, height: 6, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .resize(4, 3)
      .png()
      .toBuffer();
    assert.equal(output.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'the copied sharp resized a fixture to a PNG');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('importing pack.mjs exposes helpers without executing a release', () => {
  const source = fs.readFileSync(path.join(RELEASE_DIR, 'pack.mjs'), 'utf8');
  assert.match(source, /const isMain = process\.argv\[1\]/, 'the release entry point is guarded');
  assert.match(source, /if \(isMain\) \{/, 'the guard controls main');
  assert.equal(typeof copyDependencyClosure, 'function', 'the imported helper is usable');
});

test('Desktop metadata-only bundle does not pull sharp through the session barrel', async () => {
  const result = await build({
    stdin: {
      contents: "import { resolveModelMetadata } from '@wrenyard/session/model-metadata'; export default resolveModelMetadata('x/y');",
      resolveDir: DESKTOP_DIR,
      loader: 'js',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  const text = result.outputFiles.map((file) => file.text).join('\n');
  assert.match(text, /resolveModelMetadata/, 'the narrow entry resolves the metadata helper');
  for (const needle of ['sharp', 'libvips', '@img/', 'detect-libc']) {
    assert.equal(text.includes(needle), false, `the metadata-only bundle leaked ${needle}`);
  }
  // The full barrel imports media.ts (which imports sharp), so it would drag the
  // native module into Desktop main; the narrow subpath export is what avoids it.
  const index = fs.readFileSync(path.join(SESSION_DIR, 'src', 'index.ts'), 'utf8');
  assert.match(index, /from '\.\/media\.ts'/, 'the barrel does import the sharp-backed media module');
});
