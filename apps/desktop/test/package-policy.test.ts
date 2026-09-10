import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronBuilderRequire = createRequire(require.resolve('electron-builder'));
const asar = electronBuilderRequire('@electron/asar') as {
  createPackage(source: string, destination: string): Promise<void>;
};
const packagePolicy = require('../tools/after-pack.cjs') as {
  assertNoForbiddenPackagedEntries(entries: string[]): void;
  assertSafeDesktopPackage(context: unknown): Promise<void>;
  buildRootNeedles(roots?: string[]): string[];
  containsLocalPath(content: Buffer, needles: string[]): boolean;
  containsUnsafePackagedPath(
    archivePath: string,
    content: Buffer,
    exactNeedles: string[],
    genericNeedles: string[],
  ): boolean;
  genericHomeNeedles(): string[];
  isFirstPartyArchivePath(archivePath: string): boolean;
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

test('first-party classification mirrors dependency path semantics', () => {
  const vendorScope = ['@wrenyard', 'desktop'].join('/');
  assert.equal(packagePolicy.isFirstPartyArchivePath('/dist/main.js'), true);
  assert.equal(packagePolicy.isFirstPartyArchivePath('/node_modules/sharp/build/Release/sharp.node'), false);
  assert.equal(packagePolicy.isFirstPartyArchivePath('/node_modules/rg/bin/rg'), false);
  assert.equal(packagePolicy.isFirstPartyArchivePath(`/node_modules/${vendorScope}/dist/main.js`), true);
});

test('build-root needles cover exact checkout output for any archive member', () => {
  const exactRoot = ['', 'ci', 'workspace', 'project'].join('/');
  const needles = packagePolicy.buildRootNeedles([exactRoot]);
  const injected = `binary\0${exactRoot}/apps/desktop/release/mac/App.app`;
  assert.equal(packagePolicy.containsLocalPath(Buffer.from(injected), needles), true);
  const windowsRoot = 'C:\\ci\\workspace\\project';
  assert.equal(
    packagePolicy.containsLocalPath(Buffer.from(`${windowsRoot}\\out\\App`), packagePolicy.buildRootNeedles([windowsRoot])),
    true,
  );
  assert.equal(
    packagePolicy.containsLocalPath(
      Buffer.from(JSON.stringify({ root: exactRoot })),
      packagePolicy.buildRootNeedles([exactRoot]),
    ),
    true,
  );
});

test('generic home and temp needles are scoped to first-party output', () => {
  const needles = packagePolicy.genericHomeNeedles();
  assert.ok(needles.length > 0, 'generic home/temp needle set must not be empty');
  // A generic per-user root is a synthetic stand-in for homedir()/tmpdir(); build
  // it from components so no literal absolute home path appears in this file.
  const genericHome = ['', 'home', 'generic-ci-user'].join('/');
  const genericTemp = ['', 'var', 'folders', 'tmp', 'generic-temp'].join('/');
  const upstreamBinaryPath = '/node_modules/sharp/build/Release/sharp.node';
  const dependencyBinary = Buffer.concat([
    Buffer.from(`\0sharp-libvips\0${genericHome}/travis/build${genericTemp}\0`),
    Buffer.from([0]),
  ]);
  const genericNeedles = packagePolicy.buildRootNeedles([genericHome, genericTemp]);
  const noExactNeedles: string[] = [];
  assert.equal(packagePolicy.isFirstPartyArchivePath(upstreamBinaryPath), false,
    'upstream binary members are third-party');
  assert.equal(
    packagePolicy.containsUnsafePackagedPath(upstreamBinaryPath, dependencyBinary, noExactNeedles, genericNeedles),
    false,
    'generic home and temp bytes in a dependency NUL binary are not a finding',
  );
  assert.equal(
    packagePolicy.containsUnsafePackagedPath('/dist/main.js', dependencyBinary, noExactNeedles, genericNeedles),
    true,
    'the same generic bytes in first-party output are a finding',
  );
  assert.equal(
    packagePolicy.containsUnsafePackagedPath('/node_modules/@wrenyard/pkg/dist/index.js', dependencyBinary, noExactNeedles, genericNeedles),
    true,
    'dependency bytes under @wrenyard are first-party and are a finding',
  );
  assert.equal(
    packagePolicy.containsUnsafePackagedPath('/node_modules/@wrenyard/pkg/node_modules/other/index.js', dependencyBinary, noExactNeedles, genericNeedles),
    false,
    'a nested dependency under @wrenyard is third-party',
  );
  assert.equal(
    packagePolicy.containsLocalPath(Buffer.from('portable runtime content'), needles),
    false,
  );
  assert.equal(
    packagePolicy.buildRootNeedles([genericHome]).includes(genericHome.replaceAll('\\', '/')),
    true,
  );
});

test('exact checkout and separate output roots are rejected in any member', () => {
  const checkoutRoot = ['', 'ci', 'workspace', 'project'].join('/');
  const outputRoot = ['', 'ci', 'separate-output', 'release', 'mac'].join('/');
  const exactNeedles = packagePolicy.buildRootNeedles([checkoutRoot, outputRoot]);
  const genericNeedles = packagePolicy.genericHomeNeedles();
  const dependencyBinary = (needle: string) => Buffer.concat([
    Buffer.from(`\0sharp-libvips\0${needle}/node_modules/sharp\0`),
    Buffer.from([0]),
  ]);
  assert.equal(
    packagePolicy.containsUnsafePackagedPath('/node_modules/sharp/build/Release/sharp.node', dependencyBinary(checkoutRoot), exactNeedles, genericNeedles),
    true,
    'exact checkout root in a dependency NUL binary is a finding',
  );
  assert.equal(
    packagePolicy.containsUnsafePackagedPath('/node_modules/sharp/build/Release/sharp.node', dependencyBinary(outputRoot), exactNeedles, genericNeedles),
    true,
    'separate outside-checkout output root in a dependency NUL binary is a finding',
  );
  assert.equal(
    packagePolicy.containsUnsafePackagedPath('/dist/main.js', Buffer.from(JSON.stringify({ root: checkoutRoot })), exactNeedles, genericNeedles),
    true,
  );
  assert.equal(
    packagePolicy.containsUnsafePackagedPath('/dist/main.js', Buffer.from(JSON.stringify({ root: outputRoot })), exactNeedles, genericNeedles),
    true,
  );
  assert.equal(
    packagePolicy.containsUnsafePackagedPath('/dist/main.js', Buffer.from('portable runtime content'), exactNeedles, genericNeedles),
    false,
  );
});

test('POSIX needles match backslash and JSON-double-backslash spellings', () => {
  const checkoutRoot = ['', 'ci', 'generic-workspace', 'project'].join('/');
  const windowsRoot = 'C:\\ci\\generic-workspace\\project';
  const needles = packagePolicy.buildRootNeedles([checkoutRoot, windowsRoot]);
  const genericNeedles = packagePolicy.genericHomeNeedles();
  const variants = [
    checkoutRoot,
    JSON.stringify(checkoutRoot).slice(1, -1),
    checkoutRoot.replaceAll('/', '\\'),
    JSON.stringify(checkoutRoot.replaceAll('/', '\\')).slice(1, -1),
    windowsRoot,
    JSON.stringify(windowsRoot).slice(1, -1),
    String.raw`C:\\ci\\generic-workspace\\project`,
    String.raw`C:\\ci\\generic-workspace\\project`.replaceAll('\\', '\\\\'),
  ];
  for (const variant of variants) {
    assert.equal(
      packagePolicy.containsUnsafePackagedPath('/dist/main.js', Buffer.from(variant), needles, genericNeedles),
      true,
      `raw/backslash/JSON-doubled variant must be detected: ${variant}`,
    );
  }
});

/** Real-archive harness: build an isolated app output, pack it with the same
 * createPackage production uses, and run the exported scanner against it.
 * electronPlatformName win32 keeps the flat resources path on every host, so
 * native member lookups are still exercised on macOS and Linux CI. */
async function withRealPackage(
  files: Record<string, string>,
  run: (context: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const roots: string[] = [];
  try {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'wrenyard-policy-src-'));
    const appOutDir = mkdtempSync(join(tmpdir(), 'wrenyard-policy-out-'));
    roots.push(sourceRoot, appOutDir);
    for (const [relativePath, content] of Object.entries(files)) {
      const target = join(sourceRoot, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const resources = join(appOutDir, 'resources');
    mkdirSync(resources, { recursive: true });
    await asar.createPackage(sourceRoot, join(resources, 'app.asar'));
    await run({
      appOutDir,
      electronPlatformName: 'win32',
      packager: { appInfo: { productFilename: 'Wrenyard' } },
    });
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

test('real archive scanner accepts safe scoped-package content', async () => {
  await withRealPackage({
    'dist/main.js': 'portable first-party runtime content\n',
    'node_modules/@example/sdk/lib/index.js': 'module.exports = 42;\n',
  }, async (context) => {
    await assert.doesNotReject(() => packagePolicy.assertSafeDesktopPackage(context));
  });
});

test('real archive scanner rejects forbidden source maps', async () => {
  await withRealPackage({
    'dist/main.js': 'portable first-party runtime content\n',
    'dist/main.js.map': '{"version":3,"sources":[]}\n',
  }, async (context) => {
    await assert.rejects(
      () => packagePolicy.assertSafeDesktopPackage(context),
      (error: unknown) => error instanceof Error && error.message.includes('source_maps=1'),
    );
  });
});

test('real archive scanner rejects exact output root leaked from first-party output', async () => {
  let leakedRoot = '';
  await withRealPackage({
    'node_modules/@example/sdk/lib/index.js': 'module.exports = 42;\n',
    'dist/main.js': 'placeholder\n',
  }, async (context) => {
    leakedRoot = context.appOutDir as string;
    const target = join(leakedRoot, 'resources', 'app.asar');
    rmSync(target, { force: true });
    const sourceRoot = mkdtempSync(join(tmpdir(), 'wrenyard-policy-src-'));
    try {
      mkdirSync(join(sourceRoot, 'dist'), { recursive: true });
      mkdirSync(join(sourceRoot, 'node_modules', '@example', 'sdk', 'lib'), { recursive: true });
      writeFileSync(join(sourceRoot, 'node_modules', '@example', 'sdk', 'lib', 'index.js'), 'module.exports = 42;\n');
      writeFileSync(join(sourceRoot, 'dist', 'main.js'), `const root = ${JSON.stringify(leakedRoot)};\n`);
      await asar.createPackage(sourceRoot, target);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
    await assert.rejects(
      () => packagePolicy.assertSafeDesktopPackage(context),
      (error: unknown) => error instanceof Error
        && error.message.includes('local_paths=1')
        && !error.message.includes(leakedRoot),
    );
  });
});
