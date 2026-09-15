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
// Comments are stripped before static assertions so prose that merely mentions
// an API or a flag cannot satisfy a check that should match real code.
const codeOnly = (source) => source.replace(/^[ \t]*#.*$/gm, '');
const shellCode = codeOnly(installer);

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

test('install.ps1 extracts both Windows ZIPs with checked System32 tar.exe', () => {
  assert.doesNotMatch(ps1, /Expand-Archive/);
  assert.match(ps1, /function Expand-NativeZip/);
  assert.match(ps1, /SystemRoot/);
  assert.match(ps1, /System32\\tar\.exe/);
  assert.match(ps1, /--no-same-owner --no-same-permissions/);
  assert.match(ps1, /\$tarExitCode = \$LASTEXITCODE/);
  assert.match(ps1, /if \(\$tarExitCode -ne 0\)/);
  assert.match(ps1, /Expand-NativeZip -Archive \$zipPath -Destination \$extract/);
  assert.match(ps1, /Expand-NativeZip -Archive \$desktopZip -Destination \$desktopExtract/);
});

test('installers no longer expose or stage a standalone Pet release asset', () => {
  assert.doesNotMatch(installer, /--pet-url|PET_URL|wrenyard-pet|apps\/pet/);
  assert.doesNotMatch(ps1, /PetUrl|PetChecksumUrl|wrenyard-pet|apps\\pet|Wrenyard Pet\.exe/);
});

test('installers discover releases from static update metadata, never the REST API', () => {
  assert.ok(!/api\.github\.com/.test(installer), 'install.sh must not call the GitHub REST API');
  assert.ok(!/api\.github\.com/.test(ps1), 'install.ps1 must not call the GitHub REST API');
  assert.ok(!/Invoke-RestMethod/.test(ps1), 'install.ps1 must have no REST fallback');
  assert.ok(!/resolve_release_asset_sha256|resolve_latest/.test(shellCode));

  // The static metadata base is configurable and defaults to the public
  // raw.githubusercontent.com updates directory under the repository.
  assert.ok(installer.includes('WRENYARD_UPDATE_BASE_URL'));
  assert.ok(installer.includes('https://raw.githubusercontent.com/$REPO/updates'));
  assert.ok(installer.includes('"$UPDATE_BASE_URL/dev.json"'));
  assert.ok(installer.includes('versions/$DIR_VERSION.json'));
  assert.ok(installer.includes('wrenyard.update.v1'));

  assert.ok(ps1.includes('WRENYARD_UPDATE_BASE_URL'));
  assert.ok(ps1.includes('https://raw.githubusercontent.com/$Repo/updates'));
  assert.ok(ps1.includes("Get-UpdateDocument 'dev.json'"));
  assert.ok(ps1.includes('Assert-ExactVersionDocument'));
  assert.ok(ps1.includes("versions/$DirVersion.json"));
  assert.ok(ps1.includes('wrenyard.update.v1'));

  // Both platform installers enforce the same distinct canonical four-asset
  // contract, and the cached dev.json from -Update is validated through the
  // same assertion instead of skipping every static check.
  assert.ok(ps1.includes('$expectedNames = @('));
  assert.ok(ps1.includes('wrenyard-$ExpectedVersion-darwin-arm64-suite.zip'));
  assert.ok(ps1.includes('wrenyard-desktop-$ExpectedVersion-darwin-arm64.zip'));
  assert.ok(ps1.includes('wrenyard-$ExpectedVersion-win32-x64-suite.zip'));
  assert.ok(ps1.includes('wrenyard-desktop-$ExpectedVersion-win32-x64.zip'));
  assert.ok(ps1.includes('$seen.ContainsKey($assetName)'));
  assert.ok(ps1.includes('has an unexpected asset name'));
  assert.ok(ps1.includes('has duplicate asset records'));
  assert.ok(ps1.includes('$versionDoc = Assert-ExactVersionDocument -Name $versionDocumentName -ExpectedVersion $DirVersion'));

  // The -Url + -ChecksumUrl + -SuiteOnly direct install bypasses ALL static
  // metadata lookup and validation so an offline custom smoke install works.
  assert.ok(ps1.includes('$directBypass = $CustomUrl -and [bool]$ChecksumUrl -and $SuiteOnly'));
  assert.ok(ps1.includes('if (-not $directBypass) {'));
  assert.ok(ps1.includes('$AssetName = "wrenyard-$DirVersion-win32-x64-suite.zip"'));

  // Documents are fetched once and cached for the lifetime of the run.
  assert.ok(ps1.includes('$documentCache.ContainsKey($Name)'));
  assert.ok(installer.includes('[ -f "$dest" ] && return 0'));

  // Raw 64-hex digests are the published contract on both platforms: the
  // `sha256:` prefixed REST digest shape must no longer appear.
  assert.ok(!/\.digest/.test(ps1));
  assert.ok(ps1.includes('^[0-9a-f]{64}$'));
  assert.ok(installer.includes("grep -Eq '^[0-9a-f]{64}$'"));

  // The complete version manifest must be validated before anything is
  // installed: schema, requested version, canonical URL and digest.
  assert.ok(installer.includes('update metadata version mismatch'));
  assert.ok(installer.includes('URL is not canonical'));
  assert.ok(installer.includes('malformed asset name'));
  assert.ok(installer.includes('has an unexpected asset name'));
  assert.ok(ps1.includes('URL is not canonical'));
  assert.ok(ps1.includes('update metadata version mismatch'));
  assert.ok(ps1.includes('duplicate asset records'));

  // The shell parser is macOS native plutil (no Node/Go/Python) and reads the
  // exact-four-assets array by index with no eval-based dynamic variables; the
  // handwritten awk parsers are gone.
  assert.ok(installer.includes('/usr/bin/plutil -extract assets raw -expect array'));
  assert.ok(installer.includes('assets.$index.name'));
  // The canonical per-platform names are the published cross-target contract.
  assert.ok(installer.includes('wrenyard-$DIR_VERSION-$TARGET-suite.zip'));
  assert.ok(installer.includes('wrenyard-desktop-$DIR_VERSION-$TARGET.zip'));
  assert.ok(installer.includes('wrenyard-$DIR_VERSION-win32-x64-suite.zip'));
  assert.ok(installer.includes('wrenyard-desktop-$DIR_VERSION-win32-x64.zip'));
  // No eval-built ASSET_NAME_n/ASSET_URL_n/ASSET_SHA_n indirection survives;
  // each record is assigned directly to the URL/digest variable it feeds.
  assert.ok(!/\beval\b/.test(shellCode));
  assert.ok(!/ASSET_SHA_|ASSET_NAME_|ASSET_URL_/.test(shellCode));
  assert.ok(shellCode.includes('DEFAULT_URL="$URL_ENTRY"'));
  assert.ok(shellCode.includes('SUITE_SHA256="$SHA_ENTRY"'));
  assert.ok(shellCode.includes('DESKTOP_URL="$URL_ENTRY"'));
  assert.ok(shellCode.includes('DESKTOP_SHA256="$SHA_ENTRY"'));
  assert.ok(!/json_asset_strings|json_asset_count|verify_asset/.test(shellCode));

  // dev.json is ONE complete version manifest document: --update reads its
  // top-level version directly and never parses a releases list or sorts
  // versions. The same document supplies the four canonical asset records.
  assert.ok(!/version_releases|\.releases/.test(installer));
  assert.ok(installer.includes('json_top_string "$DEV_DOC" version'));
  assert.ok(installer.includes('dev.json publishes no version'));

  assert.ok(!/\.releases|Get-VersionSortKey/.test(ps1));
  assert.ok(ps1.includes('$devDoc.version'));
  assert.ok(ps1.includes('$documentCache'));
});

test('installers keep the custom URL plus checksum sidecar path', () => {
  assert.match(installer, /--checksum-url/);
  assert.match(installer, /die "--url requires --checksum-url"/);
  assert.match(installer, /checksum sidecar is invalid/);
  // The custom URL + explicit --checksum-url with --suite-only must bypass the
  // static metadata entirely: a local release smoke test runs without any
  // published manifest.
  assert.match(installer, /\[ "\$CUSTOM_URL" -eq 1 \] && \[ -n "\$CHECKSUM_URL" \] && \[ "\$SUITE_ONLY" -eq 1 \]/);
  assert.match(installer, /^    DOC=""$/m);
  // The metadata validation is guarded so a metadata-free run skips every
  // static lookup instead of dereferencing an unset document.
  assert.match(installer, /^if \[ -n "\$DOC" \]; then$/m);
  // The digest still comes from the explicit sidecar in that direct path.
  assert.match(installer, /checksum sidecar is invalid/);
  assert.match(ps1, /\[string\]\$ChecksumUrl/);
  assert.match(ps1, /-Url requires -ChecksumUrl/);
  assert.match(ps1, /checksum sidecar is invalid/);
  // A supplied URL overrides the metadata-derived default instead of being
  // replaced by it. The suite URL/digest pair is resolved inside the same
  // non-bypass block as the Desktop pair.
  assert.match(installer, /URL="\$\{URL:-\$DEFAULT_URL\}"/);
  assert.match(ps1, /if \(-not \$Url\) \{ \$Url = \[string\]\$suiteAsset\.url \}/);
});

test('installers bootstrap suite plus Desktop from metadata assets', () => {
  const sh = readFileSync(installerPath, 'utf8');
  const ps1Source = readFileSync(ps1Path, 'utf8');

  assert.match(sh, /--suite-only/);
  assert.match(sh, /wrenyard-desktop-\$DIR_VERSION-\$TARGET\.zip/);
  assert.doesNotMatch(sh, /CHECKSUM_URL="\$\{CHECKSUM_URL:-\$URL\.sha256\}"/);
  assert.match(sh, /DESKTOP_SHA256/);

  assert.match(ps1Source, /\[switch\]\$SuiteOnly/);
  assert.match(ps1Source, /wrenyard-desktop-\$DirVersion-win32-x64\.zip/);
  assert.match(ps1Source, /\$desktopSha256/);
  assert.doesNotMatch(ps1Source, /\$ChecksumUrl = "\$Url\.sha256"/);
});

test('shell installer resolves the complete version manifest with native plutil and current-shell digests', () => {
  // The shell discovery path uses the native macOS plist parser and the single
  // validation loop reads each of the four assets by array index into the
  // current shell, assigning each digest straight to the variable the download
  // step reuses instead of an eval-built indirection.
  assert.ok(shellCode.includes('json_top_string "$DEV_DOC" schema_version'));
  assert.ok(shellCode.includes('json_top_string "$DEV_DOC" version'));
  assert.ok(shellCode.includes('DEV_DOC="$META_DIR/dev.json"'));
  assert.ok(shellCode.includes('META_DIR="$(mktemp -d'));
  assert.ok(shellCode.includes('trap \'rm -rf "$TMP_DIR" "$META_DIR" "$NETRC"\' EXIT'));
  assert.ok(shellCode.includes('/usr/bin/plutil -extract "assets.$index.name" raw -expect string'));
  assert.ok(shellCode.includes('EXPECTED_ASSET_COUNT=4'));
  assert.ok(shellCode.includes('mkdir -p "$(dirname "$dest")"'));
  // The digest is captured into the current-shell variable that the download
  // step reuses, and nothing pipes the asset reader into a subshell.
  assert.ok(shellCode.includes('SUITE_SHA256="$SHA_ENTRY"'));
  assert.ok(shellCode.includes('DESKTOP_SHA256="$SHA_ENTRY"'));
  assert.ok(shellCode.includes('SEEN_NAMES="|"'));
  assert.ok(shellCode.includes('*"|$NAME|"*'));
  assert.ok(!/json_asset_strings|json_asset_count|verify_asset|while IFS= read/.test(shellCode));
  assert.ok(!/json_top_strings|version_sort_key/.test(shellCode));
  assert.ok(!/CHANNEL_TMP/.test(shellCode));
});

test('installer test fixtures reject a missing, wrong or malformed checksum', () => {
  // The installers must run the digest comparison on the downloaded archive
  // and refuse an invalid sidecar value before any install step.
  assert.match(installer, /\[ "\$ACTUAL" = "\$EXPECTED" \] \|\| die "checksum mismatch/);
  assert.match(ps1, /if \(\$actual -ne \$expected\) \{ Die "checksum mismatch/);
  assert.match(installer, /checksum sidecar is invalid/);
  assert.match(ps1, /checksum sidecar is invalid/);
  assert.match(installer, /has an invalid SHA-256 digest/);
  assert.match(ps1, /has an invalid SHA-256 digest/);
});
