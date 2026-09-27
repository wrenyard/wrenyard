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
