// Bootstrap installer tests.
//
// These tests drive the real scripts/install.sh (bash) and scripts/install.ps1
// (powershell.exe) with a per-test fake network layer, proving that the
// bootstrap scripts validate the static feed, verify the suite digest, extract
// the archive, and hand the archive to the install engine. No JS surrogate
// re-implements the scripts: the assertions observe what the real scripts did.
//
// Behaviour:
//   * darwin arm64: `bash scripts/install.sh` runs with fake `curl` and `ditto`
//     executables first on PATH. Fake curl serves the feed JSON and the suite
//     bytes; fake ditto stages a fake engine executable; the real plutil and
//     shasum parse and hash. The fake engine records its argv.
//   * win32 x64: `powershell.exe -NoProfile -Command` runs with an in-process
//     `Invoke-WebRequest` mock and a fake `tar.exe` compiled on the fly. The
//     fake tar stages the fake engine; the fake engine records its argv.
//   * every other host is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const NATIVE_HOST =
  (process.platform === 'darwin' && process.arch === 'arm64') ||
  (process.platform === 'win32' && process.arch === 'x64');
const SKIP_REASON = `bootstrap tests support darwin-arm64 and win32-x64, not ${process.platform}-${process.arch}`;
// Native PowerShell cold startup on hosted Windows runners can exceed 10 seconds.
const PROCESS_TIMEOUT_MS = 30_000;
const CASE_TIMEOUT_MS = PROCESS_TIMEOUT_MS + 5_000;

const VERSION = '9.9.9';
const BASE = 'https://raw.githubusercontent.com/wrenyard/wrenyard/updates';
const SUITE_BYTES = Buffer.from('suite-payload-for-bootstrap-tests\n', 'utf8');
const SUITE_SHA = createHash('sha256').update(SUITE_BYTES).digest('hex');
const DESKTOP_SHA = 'd'.repeat(64);

function asset(name, sha256) {
  return { name, url: `https://example.test/${name}`, sha256 };
}

function canonicalAssets(version, { suiteSha = SUITE_SHA } = {}) {
  return [
    asset(`wrenyard-${version}-darwin-arm64-suite.zip`, suiteSha),
    asset(`wrenyard-desktop-${version}-darwin-arm64.zip`, DESKTOP_SHA),
    asset(`wrenyard-${version}-win32-x64-suite.zip`, suiteSha),
    asset(`wrenyard-desktop-${version}-win32-x64.zip`, DESKTOP_SHA),
  ];
}

function feedDocument({ version = VERSION, schema = 'wrenyard.update.v1', assets, suiteSha } = {}) {
  return {
    schema_version: schema,
    version,
    published_at: '2026-09-25T00:00:00Z',
    assets: assets ?? canonicalAssets(version, { suiteSha }),
  };
}

function feedText(options) {
  return `${JSON.stringify(feedDocument(options), null, 2)}\n`;
}

// Every case: a feed document to serve plus the expected observable outcome
// after running the real bootstrap script.
const CASES = [
  {
    id: 'valid-feed-downloads-verifies-extracts-and-runs-engine',
    served: feedText(),
    args: [],
    expectFeedUrl: `${BASE}/dev.json`,
    expectEngine: true,
    expectExitZero: true,
  },
  {
    id: 'digest-mismatch-fails-before-the-engine',
    served: feedText({ suiteSha: 'f'.repeat(64) }),
    args: [],
    expectFeedUrl: `${BASE}/dev.json`,
    expectEngine: false,
    expectExitZero: false,
  },
];

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrenyard-bootstrap-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// ---------------------------------------------------------------------------
// POSIX / bash path
// ---------------------------------------------------------------------------

// Fake `curl` for scripts/install.sh. It records every requested URL, answers a
// *.json request with the feed fixture, and writes the suite bytes for any other
// request. It deliberately handles the exact `-o <file>` form the script uses.
function writeFakeCurl(dir) {
  const curlPath = path.join(dir, 'curl');
  fs.writeFileSync(curlPath, `#!/bin/sh
out=""; url=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; prev=""; continue; fi
  case "$a" in
    -o) prev="-o" ;;
    http://*|https://*) url="$a" ;;
  esac
done
printf '%s\\n' "$url" >> "$FAKE_CURL_LOG"
case "$url" in
  *.json) cp "$FAKE_FEED" "$out" ;;
  *) cp "$FAKE_SUITE" "$out" ;;
esac
`, 'utf8');
  fs.chmodSync(curlPath, 0o755);
}

// Fake `ditto`: stages the fake engine executable instead of unpacking a real
// archive. The last argument is the extraction destination.
function writeFakeDitto(dir) {
  const dittoPath = path.join(dir, 'ditto');
  fs.writeFileSync(dittoPath, `#!/bin/sh
dest=""
for a in "$@"; do dest="$a"; done
mkdir -p "$dest"
cp "$FAKE_ENGINE" "$dest/wrenyard"
chmod +x "$dest/wrenyard"
`, 'utf8');
  fs.chmodSync(dittoPath, 0o755);
}

function writeFakeEngine(dir) {
  const enginePath = path.join(dir, 'fake-engine.sh');
  fs.writeFileSync(enginePath, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_ENGINE_LOG"
exit "\${FAKE_ENGINE_EXIT:-0}"
`, 'utf8');
  fs.chmodSync(enginePath, 0o755);
  return enginePath;
}

function runPosixCase(testCase, tmp) {
  const fakeBin = path.join(tmp, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  writeFakeCurl(fakeBin);
  writeFakeDitto(fakeBin);
  const enginePath = writeFakeEngine(fakeBin);
  const feedPath = path.join(tmp, 'feed.json');
  const suitePath = path.join(tmp, 'suite.bin');
  const logPath = path.join(tmp, 'curl.log');
  const engineLog = path.join(tmp, 'engine.log');
  fs.writeFileSync(feedPath, testCase.served, 'utf8');
  fs.writeFileSync(suitePath, SUITE_BYTES);
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(engineLog, '');

  const res = spawnSync('bash', [path.join(ROOT, 'scripts', 'install.sh'), ...testCase.args], {
    encoding: 'utf8',
    timeout: PROCESS_TIMEOUT_MS,
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      FAKE_CURL_LOG: logPath,
      FAKE_FEED: feedPath,
      FAKE_SUITE: suitePath,
      FAKE_ENGINE: enginePath,
      FAKE_ENGINE_LOG: engineLog,
    },
  });

  return { res, requests: readRequests(logPath), engineArgs: readRequests(engineLog) };
}

// ---------------------------------------------------------------------------
// Windows / PowerShell path
// ---------------------------------------------------------------------------

// Compile a tiny dual-role executable: invoked as `tar.exe` it stages a copy of
// itself as <dest>\wrenyard.exe; invoked as the engine it appends its argv to
// $FAKE_ENGINE_LOG and exits 0.
function compileFakeExecutable(destination) {
  const source = `
using System;
using System.IO;
public static class FakeBootstrap {
  public static int Main(string[] args) {
    for (int i = 0; i < args.Length; i++) {
      if (args[i] == "-C" && i + 1 < args.Length) {
        Directory.CreateDirectory(args[i + 1]);
        File.Copy(System.Reflection.Assembly.GetExecutingAssembly().Location, Path.Combine(args[i + 1], "wrenyard.exe"), true);
        return 0;
      }
    }
    string log = Environment.GetEnvironmentVariable("FAKE_ENGINE_LOG");
    if (log != null) { File.AppendAllText(log, string.Join(" ", args) + "\\n"); }
    return 0;
  }
}
`.trim();
  const command = [
    `$src = @'`,
    source,
    `'@`,
    `Add-Type -TypeDefinition $src -OutputAssembly '${destination.replace(/'/g, "''")}' -OutputType ConsoleApplication`,
  ].join('\n');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    timeout: PROCESS_TIMEOUT_MS,
  });
  if (res.status !== 0) {
    throw new Error(`could not compile the fake bootstrap executable: ${res.stderr || res.stdout}`);
  }
}

function psMockScript({ logPath, feedPath, suitePath }) {
  const quote = (value) => value.replace(/'/g, "''");
  return `
$logPath = '${quote(logPath)}'
$feedPath = '${quote(feedPath)}'
$suitePath = '${quote(suitePath)}'
function Invoke-WebRequest {
  [CmdletBinding()]
  param(
    [Parameter(Position = 0)][string]$Uri,
    [switch]$UseBasicParsing, [string]$OutFile, [hashtable]$Headers, [int]$TimeoutSec,
    [Parameter(ValueFromRemainingArguments = $true)]$Rest
  )
  Add-Content -LiteralPath $logPath -Value $Uri
  if ($Uri -like '*.json') { Copy-Item -LiteralPath $feedPath -Destination $OutFile -Force }
  else { Copy-Item -LiteralPath $suitePath -Destination $OutFile -Force }
}
`.trim();
}

function runWindowsCase(testCase, tmp) {
  const fakeBin = path.join(tmp, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  compileFakeExecutable(path.join(fakeBin, 'tar.exe'));
  const feedPath = path.join(tmp, 'feed.json');
  const suitePath = path.join(tmp, 'suite.bin');
  const logPath = path.join(tmp, 'iwr.log');
  const engineLog = path.join(tmp, 'engine.log');
  fs.writeFileSync(feedPath, testCase.served, 'utf8');
  fs.writeFileSync(suitePath, SUITE_BYTES);
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(engineLog, '');
  const mockPath = path.join(tmp, 'mock.ps1');
  fs.writeFileSync(mockPath, `${psMockScript({ logPath, feedPath, suitePath })}\n`, 'utf8');

  const inner = [
    `. '${mockPath.replace(/'/g, "''")}';`,
    `$env:FAKE_ENGINE_LOG = '${engineLog.replace(/'/g, "''")}';`,
    `& '${path.join(ROOT, 'scripts', 'install.ps1').replace(/'/g, "''")}'`,
    ...testCase.args.map((arg) => `'${arg.replace(/'/g, "''")}'`),
  ].join(' ');

  const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', inner], {
    encoding: 'utf8',
    timeout: PROCESS_TIMEOUT_MS,
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
  });

  return { res, requests: readRequests(logPath), engineArgs: readRequests(engineLog) };
}

function readRequests(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function assertCaseOutcome(testCase, { res, requests, engineArgs }) {
  assert.ifError(res.error);
  assert.equal(res.signal, null, `bootstrap terminated by ${res.signal}`);
  assert.ok(
    requests.includes(testCase.expectFeedUrl),
    `expected the feed request ${testCase.expectFeedUrl}: ${requests.join(', ')}`,
  );
  assert.deepEqual(
    requests.filter((url) => url.includes('api.github.com')),
    [],
    `the bootstrap must never call the GitHub Release API: ${requests.join(', ')}`,
  );

  if (testCase.expectEngine) {
    assert.equal(res.status, 0, `valid feed must complete: ${engineArgs.join(' | ')}`);
    const install = engineArgs.find((line) => line.startsWith('install --version'));
    assert.ok(install, `the engine must be invoked with the install command: ${engineArgs.join(' | ')}`);
    assert.ok(
      install.includes(`--version ${VERSION}`) && /--suite-zip \S*suite\.zip/.test(install),
      `the engine must receive --version and --suite-zip: ${install}`,
    );
    return;
  }

  assert.notEqual(res.status, 0, `invalid feed must fail the bootstrap: ${requests.join(', ')}`);
  assert.deepEqual(engineArgs, [], `the engine must not run on an invalid feed: ${engineArgs.join(' | ')}`);
}

for (const testCase of CASES) {
  test(`bootstrap (posix): ${testCase.id}`, {
    skip: NATIVE_HOST && process.platform === 'darwin' ? false : SKIP_REASON,
    timeout: CASE_TIMEOUT_MS,
  }, (t) => {
    const tmp = makeTmpDir(t);
    assertCaseOutcome(testCase, runPosixCase(testCase, tmp));
  });

  test(`bootstrap (windows): ${testCase.id}`, {
    skip: NATIVE_HOST && process.platform === 'win32' ? false : SKIP_REASON,
    timeout: CASE_TIMEOUT_MS,
  }, (t) => {
    const tmp = makeTmpDir(t);
    assertCaseOutcome(testCase, runWindowsCase(testCase, tmp));
  });
}
