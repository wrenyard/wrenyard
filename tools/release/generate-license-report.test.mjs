import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolvePnpmCli, runLicensesCommand } from './generate-license-report.mjs';
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
