import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { linuxAutostartPath, readLinuxOpenAtLogin, setLinuxOpenAtLogin } from './linux-autostart.js';

test('writes XDG autostart using APPIMAGE, not the FUSE exec path', () => {
  const home = mkdtempSync(join(tmpdir(), 'wrenyard-autostart-'));
  try {
    const appImage = join(home, 'wrenyard-desktop-1.0.0-linux-x64.AppImage');
    writeFileSync(appImage, 'app');
    const env = { APPIMAGE: appImage, XDG_CONFIG_HOME: join(home, 'config') };
    assert.equal(readLinuxOpenAtLogin(env, home), false);
    setLinuxOpenAtLogin(true, {
      env,
      execPath: join(home, '.mount_WrenyaXXXXXX', 'wrenyard-desktop'),
      home,
    });
    const body = readFileSync(linuxAutostartPath(env, home), 'utf8');
    assert.match(body, /StartupWMClass=wrenyard-desktop/);
    assert.match(body, /MimeType=x-scheme-handler\/wrenyard;/);
    assert.ok(body.includes(`Exec=${appImage}`));
    assert.ok(!body.includes('.mount_'));
    setLinuxOpenAtLogin(false, { env, home });
    assert.equal(readLinuxOpenAtLogin(env, home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('refuses to write autostart into a FUSE mount', () => {
  const home = mkdtempSync(join(tmpdir(), 'wrenyard-autostart-fuse-'));
  try {
    const mount = join(home, '.mount_WrenyaXXXXXX');
    const env = { APPDIR: mount, XDG_CONFIG_HOME: join(mount, 'config') };
    assert.throws(
      () => setLinuxOpenAtLogin(true, { env, execPath: join(mount, 'wrenyard-desktop'), home }),
      /挂载点/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
