import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveInstallation } from '../src/installation-discovery.js';

/**
 * Real filesystem fixtures: discovery must be driven by Node's own stat,
 * never by an external PowerShell probe, and it must follow the actual
 * symlink chain an installer creates.
 */
function fixture(): string {
  // Canonicalize once: on macOS /var is a symlink to /private/var, and
  // discovery reports canonical paths.
  return realpathSync(mkdtempSync(join(tmpdir(), 'wrenyard-discovery-')));
}

function touch(path: string, contents = 'binary'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

/** The suite layout: <root>/wrenyard beside <root>/runtime/node. */
function suite(root: string, version: string): string {
  const dir = join(root, 'versions', version);
  touch(join(dir, 'wrenyard'));
  touch(join(dir, 'runtime', 'node'));
  touch(join(dir, 'release-manifest.json'), '{}');
  return dir;
}

test('the default suite layout resolves its own runtime without any NODE env', () => {
  const root = fixture();
  try {
    const home = join(root, 'home');
    // <prefix>/versions/<v>/wrenyard beside <prefix>/versions/<v>/runtime/node,
    // reached through <prefix>/current and the public launcher shim.
    const versionDir = suite(root, '1.0.0-dev.29');
    const prefix = join(home, '.local', 'share', 'wrenyard');
    touch(join(prefix, 'bin', 'wrenyard'), 'x');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync(join(prefix, 'bin', 'wrenyard'), join(home, '.local', 'bin', 'wrenyard'));
    symlinkSync(versionDir, join(prefix, 'current'));

    const discovered = resolveInstallation({
      platform: 'darwin',
      env: {},
      home,
      exists: existsSync,
    });

    assert.equal(discovered.cliPath, join(prefix, 'bin', 'wrenyard'));
    assert.equal(discovered.runtimePath, join(versionDir, 'runtime', 'node'));
    assert.equal(discovered.reason, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WRENYARD_CLI wins and its sibling runtime is derived from the same suite', () => {
  const root = fixture();
  try {
    const custom = join(root, 'D-Apps-Wrenyard', 'current');
    touch(join(custom, 'wrenyard.exe'));
    touch(join(custom, 'runtime', 'node.exe'));

    const discovered = resolveInstallation({
      platform: 'win32',
      env: { WRENYARD_CLI: join(custom, 'wrenyard.exe'), LOCALAPPDATA: join(root, 'other') },
      home: join(root, 'home'),
      exists: existsSync,
    });

    assert.equal(discovered.cliPath, join(custom, 'wrenyard.exe'));
    assert.equal(discovered.runtimePath, join(custom, 'runtime', 'node.exe'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a custom CLI never silently mixes with the old default runtime', () => {
  const root = fixture();
  try {
    // A stale default install exists and is fully valid...
    const defaultVersion = suite(root, '0.0.1');
    mkdirSync(join(root, 'bin'), { recursive: true });
    symlinkSync(join(defaultVersion, 'wrenyard'), join(root, 'bin', 'wrenyard'));
    symlinkSync(defaultVersion, join(root, 'current'));

    // ...but the explicit custom CLI has no runtime of its own.
    const custom = join(root, 'custom', 'wrenyard.exe');
    touch(custom);

    const discovered = resolveInstallation({
      platform: 'win32',
      env: { WRENYARD_CLI: custom, LOCALAPPDATA: join(root, 'missing') },
      home: join(root, 'home'),
      exists: existsSync,
    });

    assert.equal(discovered.cliPath, custom);
    assert.equal(discovered.runtimePath, undefined, 'must not borrow an unrelated runtime');
    assert.equal(discovered.reason, 'missing-runtime');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a damaged default current link does not interfere with an explicit CLI', () => {
  const root = fixture();
  try {
    const versionDir = suite(root, '1.0.0-dev.29');
    // A broken `current` link: it points at a directory that no longer exists.
    symlinkSync(join(root, 'versions', '0.0.0-removed'), join(root, 'current'));
    touch(join(versionDir, 'wrenyard'));

    const discovered = resolveInstallation({
      platform: 'darwin',
      env: { WRENYARD_CLI: join(versionDir, 'wrenyard') },
      home: join(root, 'home'),
      exists: existsSync,
    });

    assert.equal(discovered.runtimePath, join(versionDir, 'runtime', 'node'));
    assert.equal(discovered.reason, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the npm package layout finds the runtime hidden under .wrenyard', () => {
  const root = fixture();
  try {
    const pkg = join(root, 'node_modules', '@wrenyard', 'cli');
    touch(join(pkg, 'bin', 'wrenyard.mjs'));
    touch(join(pkg, '.wrenyard', 'runtime', 'node'));

    const discovered = resolveInstallation({
      platform: 'darwin',
      env: { WRENYARD_CLI: join(pkg, 'bin', 'wrenyard.mjs') },
      home: join(root, 'home'),
      exists: existsSync,
    });

    assert.equal(discovered.runtimePath, join(pkg, '.wrenyard', 'runtime', 'node'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing CLI and missing runtime report distinct precise reasons', () => {
  const root = fixture();
  try {
    const empty = resolveInstallation({
      platform: 'linux',
      env: {},
      home: join(root, 'home'),
      exists: () => false,
    });
    assert.equal(empty.reason, 'missing-cli');
    assert.equal(empty.cliPath, undefined);

    // A real CLI with no runtime beside it: the reason is specific, not generic.
    const suiteRoot = join(root, 'suite');
    touch(join(suiteRoot, 'wrenyard'));
    const found = resolveInstallation({
      platform: 'darwin',
      env: { WRENYARD_CLI: join(suiteRoot, 'wrenyard') },
      home: join(root, 'home'),
      exists: existsSync,
    });
    assert.equal(found.cliPath, join(suiteRoot, 'wrenyard'));
    assert.equal(found.runtimePath, undefined);
    assert.equal(found.reason, 'missing-runtime');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WRENYARD_NODE_BIN overrides discovery and fails closed when it is not a file', () => {
  const root = fixture();
  try {
    const custom = join(root, 'suite');
    touch(join(custom, 'wrenyard'));
    touch(join(custom, 'runtime', 'node'));
    const override = join(root, 'pinned', 'node');
    touch(override);

    const overridden = resolveInstallation({
      platform: 'darwin',
      env: { WRENYARD_CLI: join(custom, 'wrenyard'), WRENYARD_NODE_BIN: override },
      home: join(root, 'home'),
      exists: existsSync,
    });
    assert.equal(overridden.runtimePath, override);
    assert.equal(overridden.reason, undefined);

    const broken = resolveInstallation({
      platform: 'darwin',
      env: { WRENYARD_CLI: join(custom, 'wrenyard'), WRENYARD_NODE_BIN: join(root, 'absent') },
      home: join(root, 'home'),
      exists: existsSync,
    });
    assert.equal(broken.reason, 'missing-runtime');
    assert.equal(broken.cliPath, undefined, 'a broken override never yields a half-resolved pair');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a directory named node is rejected: only a real runtime file resolves', () => {
  const root = fixture();
  try {
    const suiteRoot = join(root, 'suite');
    touch(join(suiteRoot, 'wrenyard'));
    mkdirSync(join(suiteRoot, 'runtime', 'node'), { recursive: true });

    const discovered = resolveInstallation({
      platform: 'darwin',
      env: { WRENYARD_CLI: join(suiteRoot, 'wrenyard') },
      home: join(root, 'home'),
      exists: existsSync,
    });

    assert.equal(discovered.reason, 'missing-runtime');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
