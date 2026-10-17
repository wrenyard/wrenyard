import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createLinuxApplier, isFuseMountPath, resolveAppImagePath } from './apply-linux.js';

test('isFuseMountPath detects APPDIR and .mount_ paths', () => {
  assert.equal(isFuseMountPath('/tmp/.mount_Wrenyaabc123/wrenyard-desktop'), true);
  assert.equal(
    isFuseMountPath('/tmp/.mount_Wrenyaabc123/resources/wrenyard', { APPDIR: '/tmp/.mount_Wrenyaabc123' }),
    true,
  );
  assert.equal(
    isFuseMountPath('/home/u/wrenyard-desktop-1.0.0-linux-x64.AppImage', { APPDIR: '/tmp/.mount_Wrenyaabc123' }),
    false,
  );
});

test('resolveAppImagePath returns the AppImage file and rejects the FUSE mount', () => {
  assert.equal(resolveAppImagePath({}), null);
  assert.equal(resolveAppImagePath({ APPIMAGE: '  ' }), null);
  assert.equal(
    resolveAppImagePath({ APPIMAGE: '/tmp/.mount_Wrenyaabc123/wrenyard-desktop-1.0.0-linux-x64.AppImage' }),
    null,
  );
  assert.equal(
    resolveAppImagePath({ APPIMAGE: '/home/u/wrenyard-desktop-1.0.0-linux-x64.AppImage' }),
    '/home/u/wrenyard-desktop-1.0.0-linux-x64.AppImage',
  );
});

test('prepare copies beside APPIMAGE, verifies sha256, and never writes into FUSE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-apply-linux-'));
  try {
    const appImage = join(dir, 'wrenyard-desktop-1.0.0-linux-x64.AppImage');
    const asset = join(dir, 'download.AppImage');
    writeFileSync(appImage, 'current');
    writeFileSync(asset, 'next-payload');
    chmodSync(appImage, 0o755);
    const spawned: Array<{ command: string; args: string[] }> = [];
    const applier = createLinuxApplier({
      spawnDetached: (command, args) => { spawned.push({ command, args }); },
      env: { APPIMAGE: appImage },
      pid: 4242,
    });
    assert.equal(await applier.preflight('startup'), null);
    const prepared = await applier.prepare(asset, '1.0.1');
    assert.ok(prepared.stagedAppPath);
    assert.equal(readFileSync(prepared.stagedAppPath!, 'utf8'), 'next-payload');
    assert.equal(statSync(prepared.stagedAppPath!).mode & 0o111, 0o111);
    assert.ok(!prepared.stagedAppPath!.includes('.mount_'));
    assert.equal(prepared.stagedAppPath!.startsWith(dir), true);

    applier.apply(prepared);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]?.command, '/bin/sh');
    const script = spawned[0]?.args[1] ?? '';
    assert.match(script, /kill -0 4242/);
    assert.match(script, /\/bin\/mv -f --/);
    assert.ok(script.includes(prepared.stagedAppPath!));
    assert.ok(script.includes(appImage));
    assert.ok(!script.includes('/tmp/.mount_'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepare refuses a destination inside APPDIR', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-apply-linux-fuse-'));
  try {
    const mount = join(dir, '.mount_Wrenyaabc123');
    const appImage = join(dir, 'real.AppImage');
    writeFileSync(appImage, 'current');
    const applier = createLinuxApplier({
      spawnDetached: () => undefined,
      env: { APPIMAGE: join(mount, 'wrenyard-desktop'), APPDIR: mount },
      pid: 1,
    });
    await assert.rejects(applier.prepare(appImage, '1.0.1'), /未找到 APPIMAGE 路径|挂载点/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
