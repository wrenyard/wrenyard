import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isDevelopmentSuite, main, routeCommand } from '../src/index.js';
import type { MainOptions, Runner } from '../src/index.js';

type Call = { command: string; args: string[] };

interface Recorder {
  calls: Call[];
  runner: Runner;
}

/** Runner that records invocations and reports the given statuses in order. */
function makeRunner(statuses: number[]): Recorder {
  const calls: Call[] = [];
  let next = 0;
  const runner: Runner = (command, args) => {
    calls.push({ command, args });
    const status = next < statuses.length ? statuses[next] : 0;
    next += 1;
    return { status };
  };
  return { calls, runner };
}

/** Temporary suite root with package.json, contracts/versions.json and optional release status. */
function makeSuite(releaseStatus?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-cli-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'wrenyard-suite', version: '9.9.9' }));
  mkdirSync(join(root, 'contracts'));
  writeFileSync(
    join(root, 'contracts', 'versions.json'),
    JSON.stringify({ runtime: '1.2.3', control: '2.3.4' }),
  );
  if (releaseStatus !== undefined) {
    writeFileSync(join(root, 'release-manifest.json'), JSON.stringify({ release_status: releaseStatus }));
  }
  return root;
}

/** Test options that default the resolver to "not found" so nothing real is launched. */
function baseOptions(root: string, recorder: Recorder): MainOptions {
  return {
    runner: recorder.runner,
    suiteRoot: root,
    stdout: () => {},
    stderr: () => {},
    resolver: () => null,
  };
}

test('help returns 0 and mentions Wrenyard', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  let out = '';
  const code = main(['--help'], {
    ...baseOptions(root, recorder),
    stdout: (text) => {
      out += `${text}\n`;
    },
  });
  assert.equal(code, 0);
  assert.ok(out.includes('Wrenyard'));
  assert.equal(recorder.calls.length, 0);
});

test('unknown command returns 2 with guidance', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  let err = '';
  const code = main(['frobnicate'], {
    ...baseOptions(root, recorder),
    stderr: (text) => {
      err += `${text}\n`;
    },
  });
  assert.equal(code, 2);
  assert.ok(err.includes('frobnicate'));
  assert.equal(recorder.calls.length, 0);
});

test('routeCommand maps service, task and runtime exactly', () => {
  assert.deepEqual(routeCommand(['service', 'run', 'web']), {
    kind: 'foreman',
    args: ['daemon', 'run', 'web'],
  });
  assert.deepEqual(routeCommand(['task', 'list']), { kind: 'foreman', args: ['task', 'list'] });
  assert.deepEqual(routeCommand(['runtime', 'eval', '1+1']), { kind: 'forge', args: ['eval', '1+1'] });
  assert.deepEqual(routeCommand(['update']), { kind: 'update', args: [] });
  assert.deepEqual(routeCommand(['update', '--version', '1.0.0-dev.0', '--json']), {
    kind: 'update',
    args: ['--version', '1.0.0-dev.0', '--json'],
  });
  assert.deepEqual(routeCommand([]), { kind: 'help' });
  assert.deepEqual(routeCommand(['-v']), { kind: 'version' });
  assert.deepEqual(routeCommand(['--', 'doctor']), { kind: 'doctor' });
  assert.deepEqual(routeCommand(['bogus']), { kind: 'unknown', command: 'bogus' });
});

test('daemon routes to the internal control alongside service', () => {
  assert.deepEqual(routeCommand(['daemon', 'status']), { kind: 'foreman', args: ['daemon', 'status'] });
  assert.deepEqual(routeCommand(['daemon', 'start']), { kind: 'foreman', args: ['daemon', 'start'] });
  assert.deepEqual(routeCommand(['daemon', 'doctor', '--json']), {
    kind: 'foreman',
    args: ['daemon', 'doctor', '--json'],
  });
  // Service remains an alias for the same internal control path.
  assert.deepEqual(routeCommand(['service', 'status']), { kind: 'foreman', args: ['daemon', 'status'] });
});

test('default resolver adapter honors WRENYARD_FORGE_BIN without launching real Forge', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  const binDir = mkdtempSync(join(tmpdir(), 'wrenyard-cli-bin-'));
  t.after(() => rmSync(binDir, { recursive: true, force: true }));
  const binPath = join(binDir, process.platform === 'win32' ? 'forge.exe' : 'forge');
  writeFileSync(binPath, '#!/bin/sh\necho fake forge\n');
  if (process.platform !== 'win32') {
    chmodSync(binPath, 0o755);
  }
  const code = main(['runtime', '--version'], {
    runner: recorder.runner,
    env: { WRENYARD_FORGE_BIN: binPath },
    suiteRoot: root,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(recorder.calls, [{ command: binPath, args: ['--version'] }]);
});

test('development suite enables Forge PATH fallback when the resolver finds nothing', (t) => {
  const root = makeSuite('development');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  const code = main(['runtime', '--version'], baseOptions(root, recorder));
  assert.equal(code, 0);
  assert.deepEqual(recorder.calls, [{ command: 'forge', args: ['--version'] }]);
});

for (const status of ['release', 'publishable']) {
  test(`non-development suite (${status}) rejects a missing Forge binary`, (t) => {
    const root = makeSuite(status);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const recorder = makeRunner([0]);
    const code = main(['runtime', '--version'], baseOptions(root, recorder));
    assert.notEqual(code, 0);
    assert.equal(recorder.calls.length, 0);
  });
}

test('a resolved Forge binary is used regardless of release status', (t) => {
  const root = makeSuite('release');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  const code = main(['runtime', 'x'], {
    ...baseOptions(root, recorder),
    resolver: () => '/opt/bin/forge',
  });
  assert.equal(code, 0);
  assert.deepEqual(recorder.calls, [{ command: '/opt/bin/forge', args: ['x'] }]);
});

test('doctor runs Foreman then Forge and succeeds when both pass', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0, 0]);
  const code = main(['doctor'], { ...baseOptions(root, recorder), resolver: () => '/opt/bin/forge' });
  assert.equal(code, 0);
  assert.equal(recorder.calls.length, 2);
  assert.equal(recorder.calls[0].command, process.execPath);
  assert.ok(recorder.calls[0].args[1].endsWith(join('services', 'foreman', 'bin', 'foreman.mts')));
  assert.deepEqual(recorder.calls[0].args.slice(2), ['doctor']);
  assert.deepEqual(recorder.calls[1], { command: '/opt/bin/forge', args: ['doctor', '--json'] });
});

test('doctor returns nonzero when either child fails', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const forgeFails = makeRunner([0, 1]);
  const first = main(['doctor'], { ...baseOptions(root, forgeFails), resolver: () => '/opt/bin/forge' });
  assert.notEqual(first, 0);
  assert.equal(forgeFails.calls.length, 2);

  const foremanFails = makeRunner([1, 0]);
  const second = main(['doctor'], { ...baseOptions(root, foremanFails), resolver: () => '/opt/bin/forge' });
  assert.notEqual(second, 0);
});

test('version reads the suite version and component versions', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  let out = '';
  const code = main(['version'], {
    ...baseOptions(root, recorder),
    stdout: (text) => {
      out += `${text}\n`;
    },
  });
  assert.equal(code, 0);
  assert.ok(out.includes('wrenyard 9.9.9'));
  assert.ok(out.includes('runtime: 1.2.3'));
  assert.ok(out.includes('control: 2.3.4'));
});

test('isDevelopmentSuite reads release_status from the suite manifest', () => {
  const dev = makeSuite('development');
  assert.equal(isDevelopmentSuite(dev), true);
  rmSync(dev, { recursive: true, force: true });

  const rel = makeSuite('release');
  assert.equal(isDevelopmentSuite(rel), false);
  rmSync(rel, { recursive: true, force: true });
});

test('desktop route maps to the desktop command', () => {
  assert.deepEqual(routeCommand(['desktop']), { kind: 'desktop', args: [] });
  assert.deepEqual(routeCommand(['desktop', '--dev']), { kind: 'desktop', args: ['--dev'] });
});

test('desktop honors WRENYARD_DESKTOP_BIN without launching real Electron', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  const code = main(['desktop'], {
    ...baseOptions(root, recorder),
    env: { WRENYARD_DESKTOP_BIN: '/opt/bin/wrenyard-desktop' },
  });
  assert.equal(code, 0);
  assert.deepEqual(recorder.calls, [{ command: '/opt/bin/wrenyard-desktop', args: [] }]);
});

test('desktopBin override wins over environment and layout discovery', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  const code = main(['desktop', '--dev'], {
    ...baseOptions(root, recorder),
    desktopBin: '/custom/desktop',
  });
  assert.equal(code, 0);
  assert.deepEqual(recorder.calls, [{ command: '/custom/desktop', args: ['--dev'] }]);
});

test('desktop falls back to dev Electron in a development suite', (t) => {
  const root = makeSuite('development');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binDir = join(root, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  const electron = join(binDir, process.platform === 'win32' ? 'electron.cmd' : 'electron');
  writeFileSync(electron, '#!/bin/sh\necho fake electron\n');
  if (process.platform !== 'win32') {
    chmodSync(electron, 0o755);
  }
  mkdirSync(join(root, 'apps', 'desktop'), { recursive: true });
  const recorder = makeRunner([0]);
  const code = main(['desktop'], baseOptions(root, recorder));
  assert.equal(code, 0);
  assert.equal(recorder.calls.length, 1);
  assert.ok(recorder.calls[0].command.endsWith(join('node_modules', '.bin', 'electron')));
  assert.ok(recorder.calls[0].args[0].endsWith(join('apps', 'desktop')));
});

test('desktop returns failure when nothing can be launched', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  let err = '';
  const code = main(['desktop'], {
    ...baseOptions(root, recorder),
    stderr: (text) => {
      err += `${text}\n`;
    },
  });
  assert.notEqual(code, 0);
  assert.equal(recorder.calls.length, 0);
  assert.ok(err.includes('Desktop'));
});

test('foreman is spawned with the configured nodeExecutable', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  const code = main(['status'], {
    ...baseOptions(root, recorder),
    nodeExecutable: '/opt/node/bin/node',
  });
  assert.equal(code, 0);
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].command, '/opt/node/bin/node');
  assert.equal(
    recorder.calls[0].args[0],
    join(root, 'services', 'foreman', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  );
  assert.ok(recorder.calls[0].args[1].endsWith(join('services', 'foreman', 'bin', 'foreman.mts')));
  assert.deepEqual(recorder.calls[0].args.slice(2), ['status']);
});

test('daemon executes through bundled Node and the staged tsx/Foreman control', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  const code = main(['daemon', 'start'], {
    ...baseOptions(root, recorder),
    nodeExecutable: '/suite/runtime/node',
  });
  assert.equal(code, 0);
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].command, '/suite/runtime/node');
  assert.equal(
    recorder.calls[0].args[0],
    join(root, 'services', 'foreman', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  );
  assert.ok(recorder.calls[0].args[1].endsWith(join('services', 'foreman', 'bin', 'foreman.mts')));
  assert.deepEqual(recorder.calls[0].args.slice(2), ['daemon', 'start']);
});

test('adjacent suite-root forge binary is preferred over the resolver', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const forge = join(binDir, process.platform === 'win32' ? 'forge.exe' : 'forge');
  writeFileSync(forge, '#!/bin/sh\necho fake forge\n');
  if (process.platform !== 'win32') {
    chmodSync(forge, 0o755);
  }
  const recorder = makeRunner([0]);
  const code = main(['runtime', '--version'], baseOptions(root, recorder));
  assert.equal(code, 0);
  assert.deepEqual(recorder.calls, [{ command: forge, args: ['--version'] }]);
});

test('WRENYARD_FORGE_BIN takes precedence over the adjacent suite-root forge', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'forge'), '#!/bin/sh\necho fake forge\n');
  const recorder = makeRunner([0]);
  const code = main(['runtime', 'x'], {
    ...baseOptions(root, recorder),
    env: { WRENYARD_FORGE_BIN: '/env/bin/forge' },
  });
  assert.equal(code, 0);
  assert.deepEqual(recorder.calls, [{ command: '/env/bin/forge', args: ['x'] }]);
});

test('embedded suite and component versions override the on-disk values', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  let out = '';
  const code = main(['version'], {
    ...baseOptions(root, recorder),
    suiteVersion: '0.1.0-rc.6',
    componentVersions: { runtime: '4.5.6' },
    stdout: (text) => {
      out += `${text}\n`;
    },
  });
  assert.equal(code, 0);
  assert.ok(out.includes('wrenyard 0.1.0-rc.6'));
  assert.ok(out.includes('runtime: 4.5.6'));
  assert.ok(!out.includes('9.9.9'));
  assert.ok(!out.includes('control'));
});

test('WRENYARD_RUNTIME_BIN is primary over the legacy WRENYARD_FORGE_BIN override', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  const code = main(['runtime', 'x'], {
    ...baseOptions(root, recorder),
    env: { WRENYARD_RUNTIME_BIN: '/opt/bin/runtime', WRENYARD_FORGE_BIN: '/env/bin/forge' },
  });
  assert.equal(code, 0);
  assert.deepEqual(recorder.calls, [{ command: '/opt/bin/runtime', args: ['x'] }]);
});

test('spawn failures report the error message on stderr and exit nonzero', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let err = '';
  const runner: Runner = () => ({ status: null, error: new Error('spawn ENOENT') });
  const code = main(['runtime', 'x'], {
    runner,
    suiteRoot: root,
    stdout: () => {},
    stderr: (text) => {
      err += `${text}\n`;
    },
    resolver: () => '/opt/bin/forge',
  });
  assert.notEqual(code, 0);
  assert.ok(err.includes('spawn ENOENT'));
});

test('help is Wrenyard-only and no longer advertises legacy aliases', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  let out = '';
  const code = main(['help'], {
    ...baseOptions(root, recorder),
    stdout: (text) => {
      out += `${text}\n`;
    },
  });
  assert.equal(code, 0);
  assert.ok(out.includes('Wrenyard'));
  assert.ok(!out.includes('compatibility aliases'));
  assert.ok(!out.includes('Passed through to foreman'));
  assert.ok(out.includes('update [--version V]'));
  assert.equal(recorder.calls.length, 0);
});

/** Temporary suite that also ships the bundled install.sh like a release. */
function makeReleaseSuite(): string {
  const root = makeSuite('release');
  writeFileSync(join(root, 'install.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'install.sh'), 0o755);
  return root;
}

test('update routes to the release updater and never invokes git/pnpm/go', (t) => {
  const root = makeReleaseSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  let out = '';
  const code = main(['update'], {
    ...baseOptions(root, recorder),
    // Isolate the default prefix so no real wrenyard install can turn on
    // service restart/health calls and change the recorded call set.
    env: { ...process.env, HOME: root },
    stdout: (text) => {
      out += `${text}\n`;
    },
  });
  assert.equal(code, 0);
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].command, 'bash');
  assert.ok(recorder.calls[0].args[0].endsWith(join('install.sh')));
  assert.deepEqual(recorder.calls[0].args.slice(1), ['--update']);
  assert.ok(recorder.calls.every((call) => !['git', 'pnpm', 'go'].includes(call.command)));
  assert.ok(out.includes('wrenyard updated'));
});

test('update forwards --version to the bundled installer', (t) => {
  const root = makeReleaseSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  const code = main(
    ['update', '--version', '1.0.0-dev.0'],
    { ...baseOptions(root, recorder), env: { ...process.env, HOME: root } },
  );
  assert.equal(code, 0);
  assert.equal(recorder.calls.length, 1);
  assert.deepEqual(recorder.calls[0].args.slice(1), ['--update', '--version', '1.0.0-dev.0']);
});

test('update --json emits machine-readable output', (t) => {
  const root = makeReleaseSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  let out = '';
  const code = main(['update', '--json'], {
    ...baseOptions(root, recorder),
    env: { ...process.env, HOME: root },
    stdout: (text) => {
      out += `${text}\n`;
    },
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rolledBack, false);
});

test('update without a bundled installer fails with a diagnostic', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  let err = '';
  const code = main(['update'], {
    ...baseOptions(root, recorder),
    stderr: (text) => {
      err += `${text}\n`;
    },
  });
  assert.notEqual(code, 0);
  assert.ok(err.includes('no bundled installer found'));
  assert.equal(recorder.calls.length, 0);
});

test('installed control uses the bundled node on a restricted PATH', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  const code = main(['status'], {
    ...baseOptions(root, recorder),
    nodeExecutable: '/suite/runtime/node',
    env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(code, 0);
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].command, '/suite/runtime/node');
  assert.equal(
    recorder.calls[0].args[0],
    join(root, 'services', 'foreman', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  );
  assert.ok(recorder.calls[0].args[1].endsWith(join('services', 'foreman', 'bin', 'foreman.mts')));
  assert.deepEqual(recorder.calls[0].args.slice(2), ['status']);
});
