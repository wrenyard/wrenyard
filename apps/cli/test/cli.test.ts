import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main, routeCommand } from '../src/index.js';
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

/** Temporary suite root with an installed SUITE_VERSION marker. */
function makeSuite(): string {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-cli-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'wrenyard-suite', version: '9.9.9' }));
  mkdirSync(join(root, 'apps', 'cli', 'node_modules', 'tsx', 'dist'), { recursive: true });
  writeFileSync(join(root, 'apps', 'cli', 'node_modules', 'tsx', 'dist', 'cli.mjs'), '');
  mkdirSync(join(root, 'contracts'));
  writeFileSync(
    join(root, 'contracts', 'versions.json'),
    JSON.stringify({ runtime: '1.2.3', control: '2.3.4' }),
  );
  writeFileSync(join(root, 'SUITE_VERSION'), '9.9.9\n');
  return root;
}

/** Test options that record runner invocations. */
function baseOptions(root: string, recorder: Recorder): MainOptions {
  return {
    runner: recorder.runner,
    suiteRoot: root,
    stdout: () => {},
    stderr: () => {},
    // Root every OS-specific app location at the test root so tests never
    // discover the host machine's real installed Desktop application.
    env: { HOME: root, USERPROFILE: root, LOCALAPPDATA: root },
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
  assert.ok(!out.includes('pet'));
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

test('daemon routes to the internal control', () => {
  assert.deepEqual(routeCommand(['daemon', 'status']), { kind: 'foreman', args: ['daemon', 'status'] });
  assert.deepEqual(routeCommand(['daemon', 'run']), { kind: 'foreman', args: ['daemon', 'run'] });
  assert.deepEqual(routeCommand(['daemon', 'doctor', '--json']), {
    kind: 'foreman',
    args: ['daemon', 'doctor', '--json'],
  });
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

test('desktop discovers the canonical installed application path', (t) => {
  const temp = makeSuite();
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  // Production resolves the Desktop from the suite root as ../..: the suite
  // lives in the bundle's resources, so resolveDesktop walks back out to the
  // app executable while the fixture stays inside the isolated temp parent.
  const root =
    process.platform === 'win32'
      ? join(temp, 'resources', 'wrenyard')
      : join(temp, '啾啾工坊.app', 'Contents', 'Resources', 'wrenyard');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'SUITE_VERSION'), '9.9.9\n');
  let installed: string;
  if (process.platform === 'win32') {
    installed = join(temp, 'wrenyard-desktop.exe');
  } else {
    installed = join(temp, '啾啾工坊.app', 'Contents', 'MacOS', '啾啾工坊');
  }
  mkdirSync(join(installed, '..'), { recursive: true });
  writeFileSync(installed, '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') {
    chmodSync(installed, 0o755);
  }
  const recorder = makeRunner([0]);
  const code = main(['desktop'], baseOptions(root, recorder));
  assert.equal(code, 0);
  assert.deepEqual(recorder.calls, [{ command: installed, args: [] }]);
});

test('daemon executes through bundled Node and the staged tsx/Foreman control', (t) => {
  const root = makeSuite();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recorder = makeRunner([0]);
  const code = main(['daemon', 'run'], {
    ...baseOptions(root, recorder),
    nodeExecutable: '/suite/runtime/node',
  });
  assert.equal(code, 0);
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].command, '/suite/runtime/node');
  assert.equal(
    recorder.calls[0].args[0],
    join(root, 'apps', 'cli', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  );
  assert.ok(recorder.calls[0].args[1].endsWith(join('apps', 'cli', 'src', 'index.mts')));
  assert.deepEqual(recorder.calls[0].args.slice(2), ['daemon', 'run']);
});
