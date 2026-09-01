import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyPreparedUpdate, type UpdateHelperConfig } from '../src/update-helper.js';

function fixture(platform: 'darwin' | 'win32' = 'darwin'): { root: string; config: UpdateHelperConfig } {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-update-helper-'));
  const applications = platform === 'darwin'
    ? join(root, 'Applications')
    : join(root, 'AppData', 'Local', 'Programs');
  const stageRoot = join(applications, '.wrenyard-desktop-update-fixture');
  const desktopName = platform === 'darwin' ? '啾啾工坊.app' : 'Wrenyard Desktop';
  const stagedDesktop = join(stageRoot, desktopName);
  const destinationDesktop = join(applications, desktopName);
  const userDataPath = platform === 'darwin'
    ? join(root, 'Library', 'Application Support', '@wrenyard', 'desktop')
    : join(root, 'AppData', 'Roaming', '@wrenyard', 'desktop');
  mkdirSync(stagedDesktop, { recursive: true });
  mkdirSync(destinationDesktop, { recursive: true });
  writeFileSync(join(stagedDesktop, 'version.txt'), 'new');
  writeFileSync(join(destinationDesktop, 'version.txt'), 'old');
  if (platform === 'win32') writeFileSync(join(stagedDesktop, 'wrenyard-desktop.exe'), 'new executable');
  return {
    root,
    config: {
      schema: 'wrenyard.desktop-update-helper.v1',
      platform,
      parentPid: 123,
      version: '1.0.0-dev.16',
      stagedDesktop,
      destinationDesktop,
      cliPath: join(root, 'bin', 'wrenyard'),
      userDataPath,
      resultPath: join(userDataPath, 'update-result.json'),
      cleanupRoots: [join(userDataPath, '.wrenyard-update-fixture'), stageRoot],
    },
  };
}

test('helper replaces Desktop, updates the suite and records success', async () => {
  const { root, config } = fixture();
  try {
    const commands: string[] = [];
    const relaunched: string[] = [];
    const ok = await applyPreparedUpdate(config, {
      homePath: root,
      processAlive: () => false,
      wait: async () => undefined,
      run: (command, args) => {
        commands.push(`${command} ${args.join(' ')}`);
        return 0;
      },
      relaunch: (path) => relaunched.push(path),
    });
    assert.equal(ok, true);
    assert.equal(readFileSync(join(config.destinationDesktop, 'version.txt'), 'utf8'), 'new');
    assert.ok(commands.some((command) => command.includes('update --version 1.0.0-dev.16 --suite-only --json')));
    assert.deepEqual(relaunched, [config.destinationDesktop]);
    assert.equal(JSON.parse(readFileSync(config.resultPath, 'utf8')).status, 'success');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('helper restores the previous Desktop when suite update fails', async () => {
  const { root, config } = fixture();
  try {
    const ok = await applyPreparedUpdate(config, {
      homePath: root,
      processAlive: () => false,
      wait: async () => undefined,
      run: (command) => command === config.cliPath ? 1 : 0,
      relaunch: () => undefined,
    });
    assert.equal(ok, false);
    assert.equal(existsSync(config.destinationDesktop), true);
    assert.equal(readFileSync(join(config.destinationDesktop, 'version.txt'), 'utf8'), 'old');
    assert.equal(JSON.parse(readFileSync(config.resultPath, 'utf8')).status, 'failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('helper rejects broad cleanup roots before touching the installed app', async () => {
  const { root, config } = fixture();
  try {
    config.cleanupRoots = [root, join(root, 'Applications', '.wrenyard-desktop-update-fixture')];
    await assert.rejects(() => applyPreparedUpdate(config, {
      homePath: root,
      processAlive: () => false,
      wait: async () => undefined,
      run: () => 0,
      relaunch: () => undefined,
    }), /invalid cleanup roots/);
    assert.equal(readFileSync(join(config.destinationDesktop, 'version.txt'), 'utf8'), 'old');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows helper atomically replaces the unpacked app directory without running from it', async () => {
  const { root, config } = fixture('win32');
  try {
    const commands: string[] = [];
    const ok = await applyPreparedUpdate(config, {
      homePath: root,
      processAlive: () => false,
      wait: async () => undefined,
      run: (command, args) => {
        commands.push(`${command} ${args.join(' ')}`);
        return 0;
      },
      relaunch: () => undefined,
    });
    assert.equal(ok, true);
    assert.equal(readFileSync(join(config.destinationDesktop, 'version.txt'), 'utf8'), 'new');
    assert.equal(readFileSync(join(config.destinationDesktop, 'wrenyard-desktop.exe'), 'utf8'), 'new executable');
    assert.ok(commands.some((command) => command.includes('--suite-only')));
    assert.ok(commands.every((command) => !command.includes('codesign')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
