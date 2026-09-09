import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  assertNoAbsolutePaths,
  buildReport,
  resolvePnpmCli,
  runLicensesCommand,
  stripAbsolutePaths,
} from './generate-license-report.mjs';
import { resolveSuiteRoot } from './generate-license-report.mjs';

test('runLicensesCommand spawns the Node executable against the resolved pnpm CLI', () => {
  const fakePnpmCli = path.resolve('node_modules', 'pnpm', 'bin', 'pnpm.mjs');
  const fakeRoot = '/some/suite/root';
  const calls = [];

  const fakeExecFileSync = (command, args, options) => {
    calls.push({ command, args, options });
    return '[]\n';
  };
  const fakeResolvePnpm = () => fakePnpmCli;

  const output = runLicensesCommand(fakeRoot, fakeExecFileSync, fakeResolvePnpm);

  assert.equal(output, '[]');
  assert.equal(calls.length, 1);
  const { command, args, options } = calls[0];
  assert.equal(command, process.execPath);
  assert.deepEqual(args, [fakePnpmCli, 'licenses', 'list', '--prod', '--json']);
  assert.equal(options.cwd, fakeRoot);
  assert.equal(options.encoding, 'utf8');
  assert.ok(typeof options.maxBuffer === 'number' && options.maxBuffer > 0);
  assert.notEqual(options.shell, true);
});

test('resolvePnpmCli resolves the repository-pinned pnpm CLI from the suite root', () => {
  const root = resolveSuiteRoot();
  const pnpmCli = resolvePnpmCli(root);
  assert.equal(typeof pnpmCli, 'string');
  assert.ok(pnpmCli.length > 0);
  const normalized = pnpmCli.split(path.sep).join('/');
  assert.ok(normalized.endsWith('/pnpm/bin/pnpm.mjs'), `unexpected pnpm CLI path: ${pnpmCli}`);
});

test('stripAbsolutePaths recursively removes POSIX and Windows paths while preserving attribution', () => {
  const posixHomePath = ['', 'Users', 'example-user', 'work', 'node_modules', 'example'].join('/');
  const sanitized = stripAbsolutePaths({
    name: 'example',
    version: '1.2.3',
    license: 'MIT',
    licenseText: 'Permission is hereby granted.',
    paths: [
      posixHomePath,
      'C:\\Users\\private\\work\\node_modules\\example',
      { installPath: '/opt/build/example', notice: 'retain this notice' },
    ],
    nested: {
      repository: 'https://example.invalid/example',
      local: '/tmp/example',
    },
  });

  assert.deepEqual(sanitized, {
    name: 'example',
    version: '1.2.3',
    license: 'MIT',
    licenseText: 'Permission is hereby granted.',
    paths: [{ notice: 'retain this notice' }],
    nested: { repository: 'https://example.invalid/example' },
  });
  assert.doesNotThrow(() => assertNoAbsolutePaths(sanitized));
});

test('buildReport cannot carry nested install paths into grouped license output', () => {
  const posixHomePath = ['', 'Users', 'example-user', 'work', 'node_modules', 'example'].join('/');
  const report = buildReport([{
    name: 'example',
    version: '1.2.3',
    license: 'MIT',
    paths: [posixHomePath],
    metadata: { path: 'D:\\build\\node_modules\\example', notice: 'keep' },
  }]);

  assert.doesNotThrow(() => assertNoAbsolutePaths(report));
  assert.deepEqual(report.licenseGroups[0].packages[0].paths, []);
  assert.deepEqual(report.licenseGroups[0].packages[0].metadata, { notice: 'keep' });
});

test('assertNoAbsolutePaths fails without echoing the sensitive value', () => {
  const sensitive = ['', 'Users', 'example-user', 'secret', 'path'].join('/');
  assert.throws(
    () => assertNoAbsolutePaths({ nested: [sensitive] }),
    (error) => error instanceof Error
      && /contains 1 absolute path value/u.test(error.message)
      && !error.message.includes(sensitive),
  );
});
