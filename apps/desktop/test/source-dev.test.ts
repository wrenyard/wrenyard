import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DesktopPetSettingsStore } from '../src/pet-settings-store.js';
import {
  applySourceDevelopmentIdentity,
  DESKTOP_DATA_IDENTITY,
  isSourceDevelopment,
  isSupervised,
  PRODUCT_NAME,
  resolveSourceDesktopUserData,
} from '../src/source-dev.js';

test('source-development identity uses the installed package userData path', () => {
  assert.equal(isSourceDevelopment({}), false);
  assert.equal(isSourceDevelopment({ WRENYARD_SOURCE_DEV: '1' }), true);
  assert.equal(isSupervised({ WRENYARD_DEV_SUPERVISED: '1' }), true);
  const paths: string[] = [];
  const names: string[] = [];
  applySourceDevelopmentIdentity({
    setName(name) { names.push(name); },
    setPath(name, path) { paths.push(`${name}:${path}`); },
    getPath() { return 'C:\\Users\\me\\AppData\\Roaming'; },
  }, { WRENYARD_SOURCE_DEV: '1' }, 'win32');
  // Display branding stays localized on the application name...
  assert.deepEqual(names, [PRODUCT_NAME]);
  assert.equal(PRODUCT_NAME, '啾啾工坊');
  // ...while the data identity follows the installed package name.
  assert.equal(DESKTOP_DATA_IDENTITY, '@wrenyard/desktop');
  assert.equal(
    paths.some((entry) => entry.startsWith('userData:') && entry.endsWith(join('Roaming', '@wrenyard/desktop'))),
    true,
  );
  assert.equal(paths.some((entry) => entry.includes('啾啾工坊')), false);
});

test('resolveSourceDesktopUserData matches the installed package identity on every platform', () => {
  const home = join('/home', 'me');
  assert.equal(
    resolveSourceDesktopUserData({ APPDATA: join('C:\\Users\\me\\AppData\\Roaming') }, 'win32', 'C:\\Users\\me', 'C:\\Users\\me\\AppData\\Roaming'),
    join('C:\\Users\\me\\AppData\\Roaming', '@wrenyard/desktop'),
  );
  assert.equal(
    resolveSourceDesktopUserData({}, 'darwin', home),
    join(home, 'Library', 'Application Support', '@wrenyard/desktop'),
  );
  assert.equal(
    resolveSourceDesktopUserData({}, 'linux', home),
    join(home, '.config', '@wrenyard/desktop'),
  );
  // An XDG_CONFIG_HOME set on Linux overrides the ~/.config base.
  assert.equal(
    resolveSourceDesktopUserData({ XDG_CONFIG_HOME: join(home, '.xdg') }, 'linux', home),
    join(resolve(join(home, '.xdg')), '@wrenyard/desktop'),
  );
  // The localized display brand must never name a data directory.
  for (const path of [
    resolveSourceDesktopUserData({}, 'win32', 'C:\\Users\\me', 'C:\\Users\\me\\AppData\\Roaming'),
    resolveSourceDesktopUserData({}, 'darwin', home),
    resolveSourceDesktopUserData({}, 'linux', home),
  ]) {
    assert.equal(path.includes(PRODUCT_NAME), false);
  }
});

test('explicit WRENYARD_DESKTOP_USER_DATA override is honored on every platform', () => {
  const override = resolve('custom-user-data');
  const env = { WRENYARD_DESKTOP_USER_DATA: override };
  for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
    assert.equal(resolveSourceDesktopUserData(env, platform, '/home/me'), override);
  }
});

test('source identity reuses installed release settings and keeps pet.enabled=false', () => {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-desktop-source-'));
  try {
    const appData = join(root, 'Roaming');
    const releaseDir = join(appData, '@wrenyard/desktop');
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(
      join(releaseDir, 'settings.json'),
      `${JSON.stringify({ version: 1, pet: { enabled: false, quota: { providers: [] } } }, null, 2)}\n`,
      'utf8',
    );
    const brandDir = join(appData, PRODUCT_NAME);

    let applied: string | undefined;
    applySourceDevelopmentIdentity({
      setName() { /* display branding only */ },
      setPath(name, path) { if (name === 'userData') applied = path; },
      getPath() { return appData; },
    }, { WRENYARD_SOURCE_DEV: '1' }, 'win32');

    assert.equal(applied, releaseDir);
    // Applying the source identity must not create or read the brand-named tree.
    assert.equal(existsSync(releaseDir), true);
    assert.equal(existsSync(brandDir), false);
    assert.equal(readFileSync(join(releaseDir, 'settings.json'), 'utf8').includes('@wrenyard/desktop'), false);

    const store = new DesktopPetSettingsStore({
      path: join(applied!, 'settings.json'),
      loadLegacy: () => { throw new Error('release settings must be read, not re-imported'); },
    });
    assert.equal(store.load().enabled, false);
    assert.equal(existsSync(brandDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applySourceDevelopmentIdentity is a no-op without the source-dev flag', () => {
  let named = false;
  applySourceDevelopmentIdentity({
    setName() { named = true; },
    setPath() { named = true; },
    getPath() { return '/tmp'; },
  }, {}, 'darwin');
  assert.equal(named, false);
});
