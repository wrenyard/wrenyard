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
import {
  readUpdateAttempt,
  writeUpdateAttempt,
  UPDATE_ATTEMPT_FILENAME,
  UPDATE_ATTEMPT_SCHEMA,
} from '../src/update-attempt.js';
import { applyPreparedUpdate, type UpdateHelperConfig } from '../src/update-helper.js';

/** The in-progress record the controller writes when it launches the helper. */
function beginAttempt(config: UpdateHelperConfig): void {
  writeUpdateAttempt(config.userDataPath, {
    schema: UPDATE_ATTEMPT_SCHEMA,
    sourceVersion: '1.0.0-dev.15',
    targetVersion: config.version,
    startedAt: 1_000,
    status: 'in-progress',
    phase: 'launch-helper',
  });
}

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
    assert.equal(readUpdateAttempt(config.userDataPath)?.status, 'succeeded');
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
    const result = JSON.parse(readFileSync(config.resultPath, 'utf8')) as Record<string, unknown>;
    assert.equal(result.status, 'failed');
    assert.equal(result.version, config.version);
    assert.equal(result.message, 'Daemon 套件升级失败（退出码 1）；已恢复原 Desktop');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed suite update keeps the native cause in a record that outlives cleanup', async () => {
  const { root, config } = fixture();
  try {
    beginAttempt(config);
    // Cleanup really runs, and must not take the diagnostics with it.
    mkdirSync(config.cleanupRoots[0]!, { recursive: true });
    writeFileSync(join(config.cleanupRoots[0]!, 'archive.zip'), 'staged bytes');

    const ok = await applyPreparedUpdate(config, {
      homePath: root,
      processAlive: () => false,
      wait: async () => undefined,
      run: (command) => command === config.cliPath
        ? {
          status: 1,
          stderr: `daemon refused the suite token=hunter2 at /Users/private/suite ${'x'.repeat(400)}`,
        }
        : 0,
      relaunch: () => undefined,
    });

    assert.equal(ok, false);
    assert.equal(existsSync(config.cleanupRoots[0]!), false, 'cleanup removed the work root');
    assert.equal(existsSync(join(config.userDataPath, UPDATE_ATTEMPT_FILENAME)), true);

    const attempt = readUpdateAttempt(config.userDataPath)!;
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.phase, 'suite-update');
    assert.equal(attempt.exitCode, 1);
    assert.equal(attempt.recovery, 'restored-previous');
    assert.equal(attempt.sourceVersion, '1.0.0-dev.15', 'the controller attempt is extended, not replaced');
    assert.equal(attempt.targetVersion, config.version);
    assert.equal(attempt.startedAt, 1_000);
    assert.ok((attempt.completedAt ?? 0) > 0);
    assert.match(attempt.error ?? '', /suite update failed \| daemon refused the suite/u);
    assert.equal(attempt.error?.includes('hunter2'), false);
    assert.equal(attempt.error?.includes('private'), false);
    assert.ok((attempt.error ?? '').length <= 240, 'the captured stderr stays bounded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Desktop that never exits records the parent wait instead of only a result file', async () => {
  const { root, config } = fixture();
  try {
    beginAttempt(config);
    const ok = await applyPreparedUpdate(config, {
      homePath: root,
      processAlive: () => true,
      wait: async () => undefined,
      run: () => 0,
      relaunch: () => undefined,
    });
    assert.equal(ok, false);
    const attempt = readUpdateAttempt(config.userDataPath)!;
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.phase, 'parent-wait');
    assert.equal(attempt.recovery, 'cleanup-only');
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
    const attempt = readUpdateAttempt(config.userDataPath)!;
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.phase, 'prepare');
    assert.match(attempt.error ?? '', /invalid cleanup roots/u);
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
