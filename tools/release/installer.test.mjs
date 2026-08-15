import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const installerPath = resolve(repoRoot, 'scripts', 'install.sh');
const ps1Path = resolve(repoRoot, 'scripts', 'install.ps1');
const readmePath = resolve(repoRoot, 'README.md');
const installer = readFileSync(installerPath, 'utf8');
const ps1 = readFileSync(ps1Path, 'utf8');
const readme = readFileSync(readmePath, 'utf8');

test('installer defaults to the public wrenyard/wrenyard repository', () => {
  assert.ok(installer.includes(':-wrenyard/wrenyard}'));
  // The usage text must describe the same default.
  assert.ok(installer.includes('default: wrenyard/wrenyard'));
});

test('README bootstrap uses the public raw GitHub path', () => {
  assert.ok(readme.includes('https://raw.githubusercontent.com/wrenyard/wrenyard/main/scripts/install.sh'));
  // The installer is invoked with --update and wires the launcher into the
  // conventional per-user PATH directory rather than the private data prefix.
  assert.ok(readme.includes('--update'));
  assert.ok(readme.includes('--bin-dir "$HOME/.local/bin"'));
  assert.ok(readme.includes('`~/.local/bin/wrenyard`'));
  assert.ok(readme.includes('curl -fsSL'));
  // The pipe may span a shell line continuation: `| \` then newline then bash.
  assert.ok(/[|]\s*(\\\s*)?bash -s -- --update --bin-dir "\$HOME\/\.local\/bin"/.test(readme));
  assert.ok(!readme.includes('bash -s -- --update <(gh api'));
  assert.ok(!readme.includes('<('));
});

test('README keeps private-mirror authentication optional', () => {
  assert.ok(readme.includes('GH_TOKEN'));
  assert.ok(!readme.includes('ghp_xxxxxxxx'));
  assert.ok(!readme.includes('-H "Authorization: Bearer $GH_TOKEN"'));
});

test('install.ps1 defaults to the public wrenyard/wrenyard repository', () => {
  assert.ok(ps1.includes("'wrenyard/wrenyard'"));
});
