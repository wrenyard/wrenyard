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

test('install.ps1 verifies SHA-256 without PowerShell Get-FileHash', () => {
  // The checksum must not depend on Microsoft.PowerShell.Utility module
  // auto-loading: Get-FileHash lives in that module, which may be unavailable
  // in constrained PowerShell hosts.
  assert.ok(!ps1.includes('Get-FileHash'));
  // The installer computes the digest with a self-contained .NET SHA256
  // implementation instead of a module-backed cmdlet.
  assert.ok(ps1.includes('[System.Security.Cryptography.SHA256]::Create()'));
  assert.ok(ps1.includes('ComputeHash'));
  assert.ok(ps1.includes('[System.BitConverter]::ToString'));
  // Native/stream resources are released via finally-scoped Dispose calls.
  assert.ok(ps1.includes('Dispose()'));
  assert.ok(ps1.includes('finally {'));
});

test('install.sh exposes and derives the Pet release asset', () => {
  // Explicit overrides exist for local/direct tests.
  assert.ok(installer.includes('--pet-url'));
  assert.ok(installer.includes('--pet-checksum-url'));
  // The default Pet asset is target-qualified from the same repo/tag.
  assert.ok(installer.includes('wrenyard-pet-$DIR_VERSION-$TARGET.zip'));
  // The sidecar defaults to <pet-url>.sha256.
  assert.ok(installer.includes('PET_CHECKSUM_URL="${PET_CHECKSUM_URL:-$PET_URL.sha256}"'));
});

test('install.sh verifies, validates and stages the Pet archive', () => {
  // Both archives are checksum-verified before the prefix is touched.
  assert.ok(installer.includes('sha256_of "$TMP_DIR/pet.zip"'));
  assert.ok(installer.includes('pet.zip.sha256'));
  // The packaged executable must resolve per platform and be non-empty.
  assert.ok(installer.includes('PET_EXE_BASENAME'));
  assert.ok(installer.includes('wrenyard-pet'));
  // Pet is staged into the same version tree at apps/pet.
  assert.ok(installer.includes('apps/pet'));
});

test('install.ps1 exposes and derives the Pet release asset', () => {
  assert.ok(ps1.includes('[string]$PetUrl'));
  assert.ok(ps1.includes('[string]$PetChecksumUrl'));
  assert.ok(ps1.includes('wrenyard-pet-$DirVersion-win32-x64.zip'));
  assert.ok(ps1.includes('$PetChecksumUrl = "$PetUrl.sha256"'));
});

test('install.ps1 verifies, validates and stages the Pet archive', () => {
  assert.ok(ps1.includes('pet.zip.sha256'));
  assert.ok(ps1.includes('Wrenyard Pet.exe'));
  assert.ok(ps1.includes('apps\\pet'));
});
