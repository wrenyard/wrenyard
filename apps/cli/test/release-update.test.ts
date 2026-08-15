import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  formatOutcome,
  parseUpdateArgs,
  runUpdate,
  type UpdateOptions,
  type UpdateRunner,
} from '../src/release-update.js';

interface FakeCall {
  command: string;
  args: string[];
}

interface FakeRunner {
  runner: UpdateRunner;
  calls: FakeCall[];
}

function makeFakeRunner(plan: Array<{ status?: number; error?: boolean; stdout?: string; stderr?: string }>): FakeRunner {
  const calls: FakeCall[] = [];
  let next = 0;
  const runner: UpdateRunner = (command, args) => {
    calls.push({ command, args });
    const step = plan[Math.min(next, plan.length - 1)] ?? { status: 0 };
    next += 1;
    return {
      status: step.error ? null : (step.status ?? 0),
      error: step.error ? new Error('fake spawn error') : undefined,
      stdout: step.stdout ?? '',
      stderr: step.stderr ?? '',
    };
  };
  return { runner, calls };
}

/** Temp suite/prefix with a bundled install.sh, previous version and launcher. */
function makeEnv(): { root: string; previous: string } {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-update-'));
  mkdirSync(join(root, 'versions', '1.0.0'), { recursive: true });
  mkdirSync(join(root, 'versions', '2.0.0'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'install.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'install.sh'), 0o755);
  writeFileSync(join(root, 'bin', 'wrenyard'), '#!/bin/sh\necho fake wrenyard\n');
  chmodSync(join(root, 'bin', 'wrenyard'), 0o755);
  symlinkSync('versions/1.0.0', join(root, 'current'));
  return { root, previous: 'versions/1.0.0' };
}

function baseOptions(fake: FakeRunner, envRoot: string): UpdateOptions {
  return { suiteRoot: envRoot, prefix: envRoot, runner: fake.runner, env: process.env };
}

test('POSIX: selects the bundled install.sh and passes --update plus --version', (t) => {
  const env = makeEnv();
  t.after(() => rmSync(env.root, { recursive: true, force: true }));
  const fake = makeFakeRunner([{ status: 0 }]);
  const outcome = runUpdate({ ...baseOptions(fake, env.root), version: '2.0.0' });
  assert.equal(outcome.ok, true);
  const installer = fake.calls.find((call) => call.command === 'bash');
  assert.ok(installer, 'installer must be invoked through bash');
  assert.equal(installer.args[0], join(env.root, 'install.sh'));
  assert.deepEqual(installer.args.slice(1), ['--update', '--version', '2.0.0']);
});

test('Windows: selects the bundled install.ps1 and passes -Update plus -Version', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-update-win-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'versions', '2.0.0'), { recursive: true });
  writeFileSync(join(root, 'install.ps1'), '# fake installer\n');
  const fake = makeFakeRunner([{ status: 0 }]);
  const outcome = runUpdate({
    suiteRoot: root,
    prefix: root,
    platform: 'win32',
    version: '2.0.0',
    runner: fake.runner,
    env: process.env,
  });
  assert.equal(outcome.ok, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].command, 'powershell.exe');
  assert.deepEqual(fake.calls[0].args, [
    '-NoProfile',
    '-File',
    join(root, 'install.ps1'),
    '-Update',
    '-Version',
    '2.0.0',
  ]);
});

test('source scripts are a fallback when no bundled installer exists', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-update-src-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'install.sh'), '#!/bin/sh\nexit 0\n');
  const fake = makeFakeRunner([{ status: 0 }]);
  const outcome = runUpdate({ suiteRoot: root, prefix: root, runner: fake.runner, env: process.env });
  assert.equal(outcome.ok, true);
  assert.equal(fake.calls[0].args[0], join(root, 'scripts', 'install.sh'));
});

test('parseUpdateArgs handles --version, --json and --version=V', () => {
  assert.deepEqual(parseUpdateArgs([]), { version: undefined, json: false });
  assert.deepEqual(parseUpdateArgs(['--json']), { version: undefined, json: true });
  assert.deepEqual(parseUpdateArgs(['--version', '1.0.0-dev.0']), {
    version: '1.0.0-dev.0',
    json: false,
  });
  assert.deepEqual(parseUpdateArgs(['--version=1.0.0-dev.0', '--json']), {
    version: '1.0.0-dev.0',
    json: true,
  });
  assert.throws(() => parseUpdateArgs(['--version']), /requires a value/);
  assert.throws(() => parseUpdateArgs(['--bogus']), /unknown update argument/);
});

test('installation failure rolls back the previous current target and redacts tokens', (t) => {
  const env = makeEnv();
  t.after(() => rmSync(env.root, { recursive: true, force: true }));
  const token = 'ghp_super_secret_token';
  const fake = makeFakeRunner([
    { status: 0 }, // service status -> running
    { status: 1, stderr: `private asset download failed with ${token}\nboom` }, // installer
    { status: 0 }, // ln restore
    { status: 0 }, // service restart
    { status: 0 }, // service status
  ]);
  const outcome = runUpdate({
    ...baseOptions(fake, env.root),
    env: { ...process.env, GH_TOKEN: token },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.rolledBack, true);
  assert.ok(outcome.installError, 'install error message present');
  assert.ok(!outcome.installError.includes(token), 'token must never leak into diagnostics');
  assert.ok(outcome.installError.includes('***'), 'token is redacted in diagnostics');
  assert.equal(readlinkSync(join(env.root, 'current')), env.previous);
  const commands = fake.calls.map((call) => call.command);
  assert.ok(!commands.includes('git') && !commands.includes('pnpm') && !commands.includes('go'));
});

test('successful update restarts and health-checks a running service', (t) => {
  const env = makeEnv();
  t.after(() => rmSync(env.root, { recursive: true, force: true }));
  const fake = makeFakeRunner([
    { status: 0 }, // service status -> running
    { status: 0 }, // installer
    { status: 0 }, // service restart
    { status: 0 }, // service status -> healthy
  ]);
  const outcome = runUpdate({ ...baseOptions(fake, env.root), version: '2.0.0' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.rolledBack, false);
  assert.equal(outcome.version, '2.0.0');
  const commands = fake.calls.map((call) => call.args.join(' '));
  assert.ok(commands.includes('service restart'));
  assert.equal(commands.filter((line) => line.includes('service status')).length, 2);
});

test('health-check failure after install restores the previous current and restarts it', (t) => {
  const env = makeEnv();
  t.after(() => rmSync(env.root, { recursive: true, force: true }));
  const calls: FakeCall[] = [];
  let step = 0;
  const runner: UpdateRunner = (command, args) => {
    calls.push({ command, args });
    // Simulate the installer atomically switching current to the new version.
    if (args[0]?.endsWith('install.sh')) {
      rmSync(join(env.root, 'current'), { force: true });
      symlinkSync('versions/2.0.0', join(env.root, 'current'));
      return { status: 0, stdout: '', stderr: '' };
    }
    // Emulate the production ln restore by physically replacing current with
    // the requested target before returning success.
    if (command === 'ln') {
      rmSync(join(env.root, 'current'), { force: true });
      symlinkSync(args[1], join(env.root, 'current'));
      return { status: 0, stdout: '', stderr: '' };
    }
    const plan = [0, 0, 1, 0, 0, 0];
    const status = plan[Math.min(step, plan.length - 1)] ?? 0;
    step += 1;
    return { status, stdout: '', stderr: '' };
  };
  const outcome = runUpdate({ suiteRoot: env.root, prefix: env.root, runner, env: process.env });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.rolledBack, true);
  assert.ok(outcome.healthError, 'health error message present');
  assert.equal(readlinkSync(join(env.root, 'current')), env.previous);
  const restore = calls.find((call) => call.command === 'ln');
  assert.ok(restore, 'rollback must restore the previous current target');
  assert.deepEqual(restore.args, ['-sfn', env.previous, join(env.root, 'current')]);
  const lnIndex = calls.findIndex((call) => call.command === 'ln');
  const restartIndex = calls.findIndex(
    (call, i) => i > lnIndex && call.args.join(' ').includes('service restart'),
  );
  assert.ok(restartIndex > lnIndex, 'previous version must be restored before restarting the service');
});

test('Windows rollback resolves a relative previous target to an absolute junction target', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-update-win-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'versions', '1.0.0'), { recursive: true });
  mkdirSync(join(root, 'versions', '2.0.0'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'install.ps1'), '# fake installer\n');
  writeFileSync(join(root, 'bin', 'wrenyard.cmd'), '@echo off\n');
  symlinkSync('versions/1.0.0', join(root, 'current'));
  const calls: FakeCall[] = [];
  let step = 0;
  const runner: UpdateRunner = (command, args) => {
    calls.push({ command, args });
    // Simulate the installer atomically switching current to the new version.
    if (args.join(' ').includes('install.ps1')) {
      rmSync(join(root, 'current'), { force: true });
      symlinkSync('versions/2.0.0', join(root, 'current'));
      return { status: 0, stdout: '', stderr: '' };
    }
    // Emulate the production junction restore by physically replacing current
    // with the previous version before returning success.
    if (command === 'powershell.exe' && args.join(' ').includes('New-Item -ItemType Junction')) {
      rmSync(join(root, 'current'), { force: true });
      symlinkSync('versions/1.0.0', join(root, 'current'));
      return { status: 0, stdout: '', stderr: '' };
    }
    const plan = [0, 0, 1, 0, 0]; // status, restart, health-check fail, restart, status
    const status = plan[Math.min(step, plan.length - 1)] ?? 0;
    step += 1;
    return { status, stdout: '', stderr: '' };
  };
  const outcome = runUpdate({
    suiteRoot: root,
    prefix: root,
    platform: 'win32',
    runner,
    env: process.env,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.rolledBack, true);
  assert.ok(outcome.healthError, 'health error message present');
  assert.equal(readlinkSync(join(root, 'current')), 'versions/1.0.0');
  const restore = calls.find(
    (call) => call.command === 'powershell.exe' && call.args.join(' ').includes('New-Item -ItemType Junction'),
  );
  assert.ok(restore, 'rollback must recreate the current junction');
  const psCommand = restore.args[2];
  assert.ok(
    psCommand.includes(join(root, 'versions', '1.0.0')),
    `junction target must be resolved to an absolute path, got: ${psCommand}`,
  );
  const restoreIndex = calls.indexOf(restore);
  const restartIndex = calls.findIndex(
    (call, i) => i > restoreIndex && call.args.join(' ').includes('service restart'),
  );
  assert.ok(restartIndex > restoreIndex, 'previous version must be restored before restarting the service');
});

test('update never invokes git/pnpm/go and only ever runs the installer and control', (t) => {
  const env = makeEnv();
  t.after(() => rmSync(env.root, { recursive: true, force: true }));
  const fake = makeFakeRunner([
    { status: 0 }, // service status
    { status: 0 }, // installer
    { status: 0 }, // service restart
    { status: 0 }, // service status
  ]);
  const outcome = runUpdate({ ...baseOptions(fake, env.root) });
  assert.equal(outcome.ok, true);
  assert.ok(fake.calls.length > 0, 'updater should have spawned at least the installer');
  for (const call of fake.calls) {
    assert.ok(!['git', 'pnpm', 'go'].includes(call.command), `forbidden command: ${call.command}`);
  }
  const installer = fake.calls.find((call) => call.args[0]?.endsWith('install.sh'));
  assert.ok(installer, 'bundled installer must be invoked');
});

test('formatOutcome renders human and JSON output', () => {
  assert.equal(formatOutcome({ ok: true, version: '2.0.0', rolledBack: false }, false), 'wrenyard updated to 2.0.0');
  const json = JSON.parse(formatOutcome({ ok: true, version: '2.0.0', rolledBack: false }, true));
  assert.equal(json.ok, true);
  assert.equal(json.version, '2.0.0');
  const fail = JSON.parse(
    formatOutcome({ ok: false, rolledBack: true, installError: 'boom' }, true),
  );
  assert.equal(fail.ok, false);
  assert.equal(fail.rolledBack, true);
  assert.equal(fail.error, 'boom');
});
