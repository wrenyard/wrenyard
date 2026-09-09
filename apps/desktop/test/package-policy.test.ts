import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const packagePolicy = require('../tools/after-pack.cjs') as {
  assertNoForbiddenPackagedEntries(entries: string[]): void;
  containsLocalPath(content: Buffer, needles: string[]): boolean;
  packagedPathCategory(path: string): string | null;
};

test('electron-builder excludes safe file kinds without guessing dependency directory semantics', () => {
  const config = readFileSync(join(desktopRoot, 'electron-builder.yml'), 'utf8');
  for (const pattern of [
    '!**/*.map',
    '!**/*.d.ts',
    '!**/*.d.mts',
    '!**/*.d.cts',
    '!dist/types/**',
  ]) {
    assert.ok(config.includes(pattern), `missing Desktop package exclusion ${pattern}`);
  }
  assert.doesNotMatch(config, /!node_modules\/.*(?:test|doc|example|type)/iu,
    'dependency directories must not be removed based only on generic names');
  assert.doesNotMatch(config, /!.*(?:licen[cs]e|notice|copyright)/iu,
    'license, notice, and copyright files must remain in the packaged dependency graph');
});

test('post-pack policy rejects safe file kinds and keeps uncertain dependency directories', () => {
  const entries = [
    '/dist/main.js.map',
    '/dist/types/main.d.ts',
    '/dist/types/internal.js',
  ];
  const sensitivePath = entries[0];
  assert.throws(
    () => packagePolicy.assertNoForbiddenPackagedEntries(entries),
    (error) => error instanceof Error
      && error.message.includes('source_maps=1')
      && error.message.includes('declarations=1')
      && error.message.includes('first_party_types=1')
      && !error.message.includes(sensitivePath),
  );
  assert.doesNotThrow(() => packagePolicy.assertNoForbiddenPackagedEntries([
    '/dist/main.js',
    '/node_modules/pkg/LICENSE',
    '/node_modules/ajv/dist/types/index.js',
    '/node_modules/yaml/dist/doc/directives.js',
    '/node_modules/pkg/test/runtime-fixture.js',
    '/node_modules/pkg/docs/runtime-guide.js',
    '/node_modules/pkg/examples/runtime-example.js',
  ]));
});

test('post-pack path detector finds exact local roots without exposing content', () => {
  const needle = ['', 'Users', 'example-user', 'build-root'].join('/');
  assert.equal(packagePolicy.containsLocalPath(Buffer.from(`prefix ${needle}/src/main.ts suffix`), [needle]), true);
  assert.equal(packagePolicy.containsLocalPath(Buffer.from('portable runtime content'), [needle]), false);
  assert.equal(packagePolicy.packagedPathCategory('/node_modules/pkg/LICENSE'), null);
});
