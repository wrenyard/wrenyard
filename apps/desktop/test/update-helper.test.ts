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

function fixture(): { root: string; config: UpdateHelperConfig } {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-update-helper-'));
  const applications = join(root, 'Applications');
  const stageRoot = join(applications, '.wrenyard-desktop-update-fixture');
  const stagedApp = join(stageRoot, '啾啾工坊.app');
  const destinationApp = join(applications, '啾啾工坊.app');
  mkdirSync(stagedApp, { recursive: true });
  mkdirSync(destinationApp, { recursive: true });
  writeFileSync(join(stagedApp, 'version.txt'), 'new');
  writeFileSync(join(destinationApp, 'version.txt'), 'old');
  return {
    root,
    config: {
      schema: 'wrenyard.desktop-update-helper.v1',
      parentPid: 123,
      version: '1.0.0-dev.16',
      stagedApp,
      destinationApp,
      cliPath: join(root, 'bin', 'wrenyard'),
      resultPath: join(root, 'Library', 'Application Support', '@wrenyard', 'desktop', 'update-result.json'),
      cleanupRoots: [join(root, '.wrenyard-updates', 'desktop-fixture'), stageRoot],
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
    assert.equal(readFileSync(join(config.destinationApp, 'version.txt'), 'utf8'), 'new');
    assert.ok(commands.some((command) => command.includes('update --version 1.0.0-dev.16 --json')));
    assert.deepEqual(relaunched, [config.destinationApp]);
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
    assert.equal(existsSync(config.destinationApp), true);
    assert.equal(readFileSync(join(config.destinationApp, 'version.txt'), 'utf8'), 'old');
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
    assert.equal(readFileSync(join(config.destinationApp, 'version.txt'), 'utf8'), 'old');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
