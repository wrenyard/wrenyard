// Native installer metadata tests.
//
// These tests drive the real scripts/install.sh (bash) and scripts/install.ps1
// (powershell.exe) parsers with a per-test fake network layer, proving that the
// native scripts accept valid static metadata, reach the archive download, and
// reject malformed metadata *before* any archive request. No JS surrogate
// re-implements the installer validation: the assertions observe the requests
// the real native parser emitted.
//
// Behaviour:
//   * darwin arm64: `bash scripts/install.sh` runs with a fake `curl` executable
//     first on PATH. The fake handles `-o <file>` and a URL argument, serves the
//     full manifest fixture for `json` requests, logs every requested URL, and
//     deliberately fails the archive download.
//   * win32 x64: `powershell.exe -NoProfile -Command` runs with an in-process
//     `Invoke-WebRequest` mock that returns the fixture JSON as Content and
//     throws a sentinel for any archive request; the script is invoked with
//     -Update -SuiteOnly -Prefix <temp>.
//   * every other host is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const NATIVE_METADATA_HOST =
  (process.platform === 'darwin' && process.arch === 'arm64') ||
  (process.platform === 'win32' && process.arch === 'x64');
const SKIP_REASON = `native metadata parser tests support darwin-arm64 and win32-x64, not ${process.platform}-${process.arch}`;
const CASE_TIMEOUT_MS = 10_000;

// Canonical fixture identity: one release version whose four assets are the two
// canonical suite/Desktop artifacts for each supported host triplet.
const FIXTURE_VERSION = '9.9.9';
const FIXTURE_TAG = 'v9.9.9';
const FIXTURE_PUBLISHED_AT = '2026-08-14T09:00:00Z';
const CANONICAL_BASE = 'https://github.com/wrenyard/wrenyard/releases/download';
const HOSTS = ['darwin-arm64', 'win32-x64'];

// 64-hex digests, distinct per asset so a wrong-digest regression changes a
// request rather than silently matching another asset.
const DIGEST_BY_FILE = new Map(
  [
    ...HOSTS.map((host) => `wrenyard-${FIXTURE_VERSION}-${host}-suite.zip`),
    ...HOSTS.map((host) => `wrenyard-desktop-${FIXTURE_VERSION}-${host}.zip`),
  ].map((name, index) => [name, String(index + 1).repeat(64)]),
);

function canonicalAsset(name) {
  return {
    name,
    url: `${CANONICAL_BASE}/${FIXTURE_TAG}/${name}`,
    sha256: DIGEST_BY_FILE.get(name),
  };
}

function canonicalAssets() {
  return [
    canonicalAsset(`wrenyard-${FIXTURE_VERSION}-darwin-arm64-suite.zip`),
    canonicalAsset(`wrenyard-desktop-${FIXTURE_VERSION}-darwin-arm64.zip`),
    canonicalAsset(`wrenyard-${FIXTURE_VERSION}-win32-x64-suite.zip`),
    canonicalAsset(`wrenyard-desktop-${FIXTURE_VERSION}-win32-x64.zip`),
  ];
}

function manifestDocument({ version = FIXTURE_VERSION, assets = canonicalAssets() } = {}) {
  return {
    schema_version: 'wrenyard.update.v1',
    version,
    published_at: FIXTURE_PUBLISHED_AT,
    assets,
  };
}

// Pretty JSON is deliberate: the native parsers must handle the published
// formatting, not a minified variant.
function manifestText(options) {
  return `${JSON.stringify(manifestDocument(options), null, 2)}\n`;
}

// The exact-version document URL the POSIX installer derives from the metadata
// base; an explicit --version install must read versions/<version>.json.
function versionDocUrl(version = FIXTURE_VERSION) {
  return `https://raw.githubusercontent.com/wrenyard/wrenyard/updates/versions/${version}.json`;
}

const nativeTarget = process.platform === 'win32' ? 'win32-x64' : 'darwin-arm64';
const ARCHIVE_URL = canonicalAsset(`wrenyard-${FIXTURE_VERSION}-${nativeTarget}-suite.zip`).url;

// Every fixture case: a JSON manifest to serve (or the digest to serve) plus the
// expected observable outcome after running the real native parser.
//
// `served` is either a manifest document (the fake layer answers any *.json
// fetch with it) or null (metadata is unreachable, exercising rejection paths
// that must still refuse before the archive download).
const CASES = [
  {
    id: 'valid-manifest-reaches-archive-download',
    served: manifestText(),
    // A valid document must be accepted, then the archive fetch must be
    // attempted and observed in the request log.
    expectArchiveRequest: true,
    expectVersionDoc: false,
  },
  {
    id: 'valid-manifest-reads-exact-version-document',
    served: manifestText(),
    version: FIXTURE_VERSION,
    // The nested versions/ directory must be fetched (regression: the nested
    // directory lookup once missed and had to be fixed in the shell parser).
    expectArchiveRequest: true,
    expectVersionDoc: true,
  },

  // Rejection cases: each must stop before the archive download.
  {
    id: 'duplicate-asset-names-are-rejected',
    served: manifestText({
      assets: [...canonicalAssets(), canonicalAsset(`wrenyard-${FIXTURE_VERSION}-win32-x64-suite.zip`)],
    }),
    expectArchiveRequest: false,
    expectVersionDoc: false,
  },
  {
    id: 'unknown-asset-filename-is-rejected',
    served: manifestText({
      assets: [
        ...canonicalAssets().slice(0, 3),
        { ...canonicalAsset(`wrenyard-desktop-${FIXTURE_VERSION}-darwin-arm64.zip`), name: 'wrenyard-9.9.9-unknown-host-suite.zip' },
      ],
    }),
    expectArchiveRequest: false,
    expectVersionDoc: false,
  },
  {
    id: 'wrong-canonical-url-is-rejected',
    served: manifestText({
      assets: [
        { ...canonicalAsset(`wrenyard-${FIXTURE_VERSION}-darwin-arm64-suite.zip`), url: `https://evil.invalid/${FIXTURE_TAG}/wrenyard-${FIXTURE_VERSION}-darwin-arm64-suite.zip` },
        ...canonicalAssets().slice(1),
      ],
    }),
    expectArchiveRequest: false,
    expectVersionDoc: false,
  },
  {
    id: 'malformed-sha-digest-is-rejected',
    served: manifestText({
      assets: [
        { ...canonicalAsset(`wrenyard-${FIXTURE_VERSION}-darwin-arm64-suite.zip`), sha256: 'sha256:not-a-digest' },
        ...canonicalAssets().slice(1),
      ],
    }),
    expectArchiveRequest: false,
    expectVersionDoc: false,
  },
  {
    id: 'wrong-schema-version-is-rejected',
    served: `${JSON.stringify({ ...manifestDocument(), schema_version: 'wrenyard.update.v0' }, null, 2)}\n`,
    expectArchiveRequest: false,
    expectVersionDoc: false,
  },
];

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrenyard-installer-metadata-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// ---------------------------------------------------------------------------
// POSIX / bash path
// ---------------------------------------------------------------------------

// Fake `curl` for scripts/install.sh. It records every requested URL, answers
// JSON metadata requests from $FAKE_CURL_JSON (a single manifest document for
// every *.json fetch), and fails any archive download so the test stops right
// after the installer decides an archive URL is valid.
function writeFakeCurl(dir) {
  const curlPath = path.join(dir, 'curl');
  const logPath = path.join(dir, 'curl.log');
  fs.writeFileSync(curlPath, `#!/bin/sh
out=""
url=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; prev=""; continue; fi
  case "$a" in
    -o) prev="-o" ;;
    http://*|https://*) url="$a" ;;
  esac
done
printf '%s\\n' "$url" >> "$FAKE_CURL_LOG"
case "$url" in
  *.json)
    if [ -n "$out" ]; then cat "$FAKE_CURL_JSON" > "$out"; else cat "$FAKE_CURL_JSON"; fi
    exit 0 ;;
  *)
    # Deliberately fail the archive download: reaching this branch is the
    # observable proof that validation passed.
    echo "FAKE_CURL_ARCHIVE_FAILED" >&2
    exit 22 ;;
esac
`, 'utf8');
  fs.chmodSync(curlPath, 0o755);
  return { curlPath, logPath };
}

function runPosixCase(testCase, tmp) {
  const fakeBin = path.join(tmp, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const { logPath } = writeFakeCurl(fakeBin);
  const fixturePath = path.join(tmp, 'manifest.json');
  fs.writeFileSync(fixturePath, testCase.served, 'utf8');
  fs.writeFileSync(logPath, '');
  const prefix = path.join(tmp, 'prefix');

  const res = spawnSync('bash', [
    path.join(ROOT, 'scripts', 'install.sh'),
    ...(testCase.expectVersionDoc ? ['--version', testCase.version ?? FIXTURE_VERSION] : ['--update']),
    '--suite-only',
    '--prefix', prefix,
    '--bin-dir', path.join(prefix, 'bin'),
  ], {
    encoding: 'utf8',
    timeout: CASE_TIMEOUT_MS,
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      FAKE_CURL_LOG: logPath,
      FAKE_CURL_JSON: fixturePath,
    },
  });

  return { res, requests: readRequests(logPath), prefix };
}

// ---------------------------------------------------------------------------
// Windows / PowerShell path
// ---------------------------------------------------------------------------

// PowerShell command that overrides Invoke-WebRequest for the child scope. The
// mock logs every Uri via Add-Content, returns the fixture JSON as Content for
// json requests, and throws a sentinel for any archive (non-JSON) request.
// Optional Invoke-WebRequest arguments (OutFile, Headers, Method, ...) are
// tolerated through a catch-all parameter so the mock matches the real cmdlet
// signature the installer calls.
function psMockScript({ logPath, fixturePath }) {
  const escapedLog = logPath.replace(/'/g, "''");
  const escapedFixture = fixturePath.replace(/'/g, "''");
  return `
$logPath = '${escapedLog}'
$fixturePath = '${escapedFixture}'
$fixture = Get-Content -Raw -LiteralPath $fixturePath
function Invoke-WebRequest {
  [CmdletBinding()]
  param(
    [Parameter(Position = 0)][string]$Uri,
    [switch]$UseBasicParsing, [string]$OutFile, [hashtable]$Headers, [int]$TimeoutSec,
    [Parameter(ValueFromRemainingArguments = $true)]$Rest
  )
  Add-Content -LiteralPath $logPath -Value $Uri
  if ($Uri -like '*.json') {
    return [pscustomobject]@{ Content = $fixture; StatusCode = 200; Headers = @{} }
  }
  throw [System.InvalidOperationException]::new('FAKE_IWR_ARCHIVE_FAILED')
}
`.trim();
}

function runWindowsCase(testCase, tmp) {
  const logPath = path.join(tmp, 'iwr.log');
  const fixturePath = path.join(tmp, 'manifest.json');
  fs.writeFileSync(fixturePath, testCase.served, 'utf8');
  fs.writeFileSync(logPath, '');
  const prefix = path.join(tmp, 'prefix');
  const mockPath = path.join(tmp, 'mock.ps1');
  fs.writeFileSync(mockPath, `${psMockScript({ logPath, fixturePath })}\n`, 'utf8');

  const inner = [
    `. '${mockPath.replace(/'/g, "''")}';`,
    `& '${path.join(ROOT, 'scripts', 'install.ps1').replace(/'/g, "''")}'`,
    testCase.expectVersionDoc ? `-Version '${testCase.version ?? FIXTURE_VERSION}'` : '',
    '-Update -SuiteOnly',
    `-Prefix '${prefix.replace(/'/g, "''")}'`,
    `-BinDir '${path.join(prefix, 'bin').replace(/'/g, "''")}'`,
  ].join(' ');

  const res = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', inner,
  ], { encoding: 'utf8', timeout: CASE_TIMEOUT_MS, env: { ...process.env } });

  return { res, requests: readRequests(logPath), prefix };
}

function readRequests(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function assertFixtureSchema() {
  // Guard the fixture itself: four canonical assets for the two host triplets,
  // canonical GitHub URLs, and 64-hex digests.
  const assets = canonicalAssets();
  assert.equal(assets.length, 4);
  for (const asset of assets) {
    assert.match(asset.url, new RegExp(`^${CANONICAL_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${FIXTURE_TAG}/`));
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(manifestDocument().schema_version, 'wrenyard.update.v1');
  assert.equal(manifestDocument().published_at, FIXTURE_PUBLISHED_AT);
}

test('installer metadata fixture stays canonical', () => {
  assertFixtureSchema();
});

for (const testCase of CASES) {
  test(`installer metadata (posix): ${testCase.id}`, {
    skip: NATIVE_METADATA_HOST && process.platform === 'darwin' ? false : SKIP_REASON,
    timeout: CASE_TIMEOUT_MS,
  }, (t) => {
    const tmp = makeTmpDir(t);
    const { res, requests } = runPosixCase(testCase, tmp);
    assertRequestsMatch(testCase, requests);
    if (!testCase.expectArchiveRequest) {
      assert.notEqual(res.status, 0, `rejected metadata must fail the install: ${requests.join(', ')}`);
    }
  });

  test(`installer metadata (windows): ${testCase.id}`, {
    skip: NATIVE_METADATA_HOST && process.platform === 'win32' ? false : SKIP_REASON,
    timeout: CASE_TIMEOUT_MS,
  }, (t) => {
    const tmp = makeTmpDir(t);
    const { res, requests } = runWindowsCase(testCase, tmp);
    assertRequestsMatch(testCase, requests);
    if (!testCase.expectArchiveRequest) {
      assert.notEqual(res.status, 0, `rejected metadata must fail the install: ${requests.join(', ')}`);
    }
  });
}

function assertRequestsMatch(testCase, requests) {
  const expectedMetadata = testCase.expectVersionDoc ? versionDocUrl() : 'https://raw.githubusercontent.com/wrenyard/wrenyard/updates/dev.json';
  assert.deepEqual(requests.filter((url) => url.endsWith('.json')), [expectedMetadata]);
  const archiveRequests = requests.filter((line) => line.includes('/releases/download/'));
  const apiRequests = requests.filter((line) => line.includes('api.github.com'));
  assert.deepEqual(apiRequests, [], `metadata installs must never call the GitHub Release API: ${requests.join(', ')}`);

  if (testCase.expectArchiveRequest) {
    assert.ok(
      archiveRequests.includes(ARCHIVE_URL),
      `valid metadata must reach the canonical archive download: ${requests.join(', ')}`,
    );
    return;
  }

  assert.deepEqual(
    archiveRequests,
    [],
    `invalid metadata must stop before the archive download: ${requests.join(', ')}`,
  );
}

test('explicit version reads the nested exact-version document', {
  skip: NATIVE_METADATA_HOST && process.platform === 'darwin' ? false : SKIP_REASON,
  timeout: CASE_TIMEOUT_MS,
}, (t) => {
  const tmp = makeTmpDir(t);
  const { requests } = runPosixCase(
    { served: manifestText(), version: FIXTURE_VERSION, expectArchiveRequest: true, expectVersionDoc: true },
    tmp,
  );
  const expected = versionDocUrl(FIXTURE_VERSION);
  assert.ok(
    requests.includes(expected),
    `explicit --version must read ${expected}: ${requests.join(', ')}`,
  );
  assert.ok(
    requests.includes(ARCHIVE_URL),
    `explicit --version must reach the canonical archive download: ${requests.join(', ')}`,
  );
});
