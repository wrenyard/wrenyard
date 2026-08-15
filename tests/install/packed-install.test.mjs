// End-to-end test proving that packed installs never compile on the consumer
// machine. Set WRENYARD_SKIP_PACKED_INSTALL_E2E=1 only for a deliberately
// reduced local loop; CI and `pnpm release:e2e` run it by default.
//
// It builds the local release (desktop skipped) into a temp dir, installs the
// actual CLI tarball into a throwaway consumer project, runs the standalone
// executable directly, then serves the suite zip + checksum sidecar over local
// HTTP and runs scripts/install.sh into a temp prefix. A fake `go` is placed
// early on PATH for every consumer install/run step and the test fails if it
// is ever invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import archiver from 'archiver';
import { fileURLToPath } from 'node:url';

const ENABLED = process.env.WRENYARD_SKIP_PACKED_INSTALL_E2E !== '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
// Windows builds the complete release twice in the package job (once before
// this test and once inside the isolated consumer fixture). Hosted Windows
// runners routinely need more than ten minutes for the second build alone;
// keep the tighter budget elsewhere while allowing the same assertions to
// reach their installed-command and updater checks on Windows.
const E2E_TIMEOUT_MS = process.platform === 'win32' ? 1_200_000 : 600_000;

// Host triplet embedded in the platform-qualified suite artifact name.
const TRIPLET = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-x64': 'linux-x64',
  'win32-x64': 'win32-x64',
}[`${process.platform}-${process.arch}`];

function resolveCommand(cmd, platform = process.platform) {
  const windowsPackageManager = platform === 'win32' && (cmd === 'npm' || cmd === 'pnpm');
  const windowsCommandShim = platform === 'win32' && /\.(?:cmd|bat)$/i.test(cmd);
  return {
    executable: windowsPackageManager ? `${cmd}.cmd` : cmd,
    shell: windowsPackageManager || windowsCommandShim,
  };
}

function run(cmd, args, opts = {}) {
  const invocation = resolveCommand(cmd);
  const res = spawnSync(invocation.executable, args, {
    encoding: 'utf8',
    shell: invocation.shell,
    ...opts,
  });
  if (res.status !== 0) {
    const detail = `exit=${res.status ?? res.error?.code ?? 'unknown'}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`;
    throw new Error(`command failed: ${cmd} ${args.join(' ')}\n${detail}`);
  }
  return res;
}

test('packed-install runner invokes Windows package-manager command shims', () => {
  assert.deepEqual(resolveCommand('npm', 'win32'), { executable: 'npm.cmd', shell: true });
  assert.deepEqual(resolveCommand('pnpm', 'win32'), { executable: 'pnpm.cmd', shell: true });
  assert.deepEqual(resolveCommand('C:\\tmp\\consumer\\node_modules\\.bin\\wrenyard.cmd', 'win32'), {
    executable: 'C:\\tmp\\consumer\\node_modules\\.bin\\wrenyard.cmd',
    shell: true,
  });
  assert.deepEqual(resolveCommand('C:\\tmp\\consumer\\wrenyard.BAT', 'win32'), {
    executable: 'C:\\tmp\\consumer\\wrenyard.BAT',
    shell: true,
  });
  assert.deepEqual(resolveCommand('node', 'win32'), { executable: 'node', shell: false });
  assert.deepEqual(resolveCommand('npm', 'linux'), { executable: 'npm', shell: false });
});

function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve({ status: code, stdout, stderr });
      else reject(new Error(`command failed: ${cmd} ${args.join(' ')}\nexit=${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

function findFile(dir, re) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      const hit = findFile(p, re);
      if (hit) return hit;
    } else if (re.test(p)) {
      return p;
    }
  }
  return null;
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readChecksum(shaPath) {
  return fs.readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0].toLowerCase();
}

function hasCommand(name) {
  const res = spawnSync('sh', ['-c', `command -v "${name}"`], { encoding: 'utf8' });
  return res.status === 0;
}

function snapshotInstallSentinels(root) {
  const sentinels = [
    'node_modules/.modules.yaml',
    'node_modules/.pnpm-workspace-state-v1.json',
    'node_modules/.package-map.json',
  ];
  const snapshot = {};
  for (const rel of sentinels) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) snapshot[rel] = fs.readFileSync(file);
  }
  return snapshot;
}

function assertInstallSentinelsUnchanged(root, snapshot) {
  for (const [rel, bytes] of Object.entries(snapshot)) {
    const file = path.join(root, rel);
    assert.ok(fs.existsSync(file), `workspace install sentinel removed by release build: ${rel}`);
    assert.deepEqual(fs.readFileSync(file), bytes, `workspace install sentinel mutated by release build: ${rel}`);
  }
}

// The release build must leave every root dev dependency installed.
function assertRootDevDepsAvailable(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const devDeps = Object.keys(pkg.devDependencies ?? {});
  assert.ok(devDeps.length > 0, 'root package.json declares no devDependencies to verify');
  for (const dep of devDeps) {
    assert.ok(
      fs.existsSync(path.join(root, 'node_modules', ...dep.split('/'))),
      `root dev dependency unavailable after release build: ${dep}`,
    );
  }
}

// Reject any @wrenyard self-link or virtual-store entry in a deployed Foreman
// tree: this release target has no workspace runtime dependencies. Entry-name
// checks use path.relative(root, file), so the parent npm scope
// (node_modules/@wrenyard/cli) can never make every child a violation while an
// actual @wrenyard segment inside the inspected tree still fails.
function assertNoWorkspaceLinks(root) {
  const violations = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const rel = path.relative(root, file);
      if (rel.includes('@wrenyard')) {
        violations.push(`workspace entry: ${rel}`);
        continue;
      }
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        if (target.includes('@wrenyard')) violations.push(`workspace self-link: ${rel} -> ${target}`);
      }
    }
  };
  walk(root);
  assert.ok(violations.length === 0, `@wrenyard workspace entries in extracted Foreman tree:\n${violations.join('\n')}`);
}

// A deployed Foreman tree is a portable runtime tree and must not carry
// package-manager workspace metadata: a modern pnpm deploy leaves a root
// pnpm-lock.yaml/pnpm-workspace.yaml that the release build strips, so neither
// may appear in the extracted suite or the npm-installed CLI.
function assertNoPnpmWorkspaceMetadata(foremanRoot) {
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    assert.ok(
      !fs.existsSync(path.join(foremanRoot, name)),
      `deployed Foreman tree must not ship ${name}`,
    );
  }
}

// The staged/extracted Foreman tree must contain no directory named `.bin` at
// any dependency depth. Modern pnpm layouts nest shims under deeper
// node_modules/.bin dirs (for example .pnpm/<pkg>/node_modules/.bin), and every
// shipped launcher resolves tsx through an explicit path, so a recursive check
// (not only the top-level node_modules/.bin) is what catches real regressions.
function assertNoBinDirs(foremanRoot) {
  const violations = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      if (entry.name === '.bin') {
        violations.push(file);
        continue;
      }
      walk(file);
    }
  };
  walk(foremanRoot);
  assert.ok(violations.length === 0, `Foreman tree contains .bin shim directories:\n${violations.join('\n')}`);
}

// Strip PowerShell comments (`#` to end of line) while preserving `#` inside
// single- or double-quoted strings (including backtick escapes and doubled
// single quotes), so a safety comment that merely mentions `-Recurse` cannot
// flip the guard while real recursive deletion still does.
function stripPsComments(source) {
  return source.split(/\r?\n/).map((line) => {
    let quote = null;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quote === '"') {
        if (char === '`') {
          index += 1;
          continue;
        }
        if (char === '"') quote = null;
        continue;
      }
      if (quote === "'") {
        if (char === "'") {
          if (line[index + 1] === "'") {
            index += 1;
            continue;
          }
          quote = null;
        }
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        continue;
      }
      if (char === '#') return line.slice(0, index);
    }
    return line;
  }).join('\n');
}

// Static regression guard for the Windows installer: Switch-Link must never
// recursively delete the existing `current` link. Replacing `current` goes
// through a link-only removal helper that requires a reparse point (symbolic
// link or junction) and refuses a plain directory, so the swap can never
// follow a symlink/junction into its version target and delete it.
function assertInstallPs1LinkOnlyRemoval(root) {
  const lines = fs.readFileSync(path.join(root, 'scripts', 'install.ps1'), 'utf8').split(/\r?\n/);
  const bodyOf = (functionName) => {
    const start = lines.findIndex((line) => line.trim() === `function ${functionName} {`);
    assert.ok(start !== -1, `install.ps1 contains no ${functionName} function`);
    const body = [];
    let depth = 0;
    for (let index = start; index < lines.length; index += 1) {
      const line = lines[index];
      body.push(line);
      depth += (line.match(/\{/g) ?? []).length;
      depth -= (line.match(/\}/g) ?? []).length;
      if (depth === 0 && index > start) break;
    }
    return body.join('\n');
  };

  const switchBody = stripPsComments(bodyOf('Switch-Link'));
  assert.ok(
    !/-Recurse/.test(switchBody),
    'Switch-Link must not recursively delete an existing link',
  );
  assert.ok(
    /Remove-LinkOnly/.test(switchBody),
    'Switch-Link must remove an existing link through the link-only helper',
  );

  const helperBody = stripPsComments(bodyOf('Remove-LinkOnly'));
  assert.ok(
    /ReparsePoint/.test(helperBody),
    'Remove-LinkOnly must require the existing path to be a reparse point',
  );
  assert.ok(
    !/-Recurse/.test(helperBody),
    'Remove-LinkOnly must never recurse into a link target',
  );
  assert.ok(
    /Die/.test(helperBody),
    'Remove-LinkOnly must refuse to delete a non-reparse directory',
  );
}

function readVersion(manifest, zipPath) {
  if (manifest) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (parsed && parsed.suite_version) return String(parsed.suite_version);
      if (parsed && parsed.version) return String(parsed.version);
    } catch {
      // fall back to zip-name parsing
    }
  }
  const base = path.basename(zipPath, '.zip').replace(/-suite$/, '').replace(/^wrenyard-/, '');
  // Strip the platform-qualified triplet suffix from the suite archive name.
  const version = base.replace(/-(darwin-arm64|darwin-x64|linux-x64|win32-x64)$/, '');
  assert.ok(version, `could not determine version from zip name ${zipPath}`);
  return version;
}

// Assert that a deployed dependency is a physical directory inside the tree:
// lstat must not be a symlink (a real hoisted directory, never a virtual-store
// link) and its realpath must remain in-tree. npm installs retain physical
// directories shipped inside a tarball but can prune symlinked virtual-store
// entries, so physical containment is the supported install contract.
function assertPhysicalInsideTree(root, rel) {
  const entry = path.join(root, rel);
  assert.ok(fs.existsSync(entry), `expected ${rel} under ${root}`);
  const stat = fs.lstatSync(entry);
  assert.ok(!stat.isSymbolicLink(), `${rel} under ${root} is a symlink, expected a physical directory`);
  assert.ok(stat.isDirectory(), `${rel} under ${root} is not a directory`);
  const rootReal = fs.realpathSync(root);
  const real = fs.realpathSync(entry);
  assert.ok(
    real === rootReal || real.startsWith(rootReal + path.sep),
    `${rel} realpath ${real} escapes the tree rooted at ${rootReal}`,
  );
}

// Walk a tree asserting that every symlink is relative, stays inside the tree
// and resolves to an existing entry: absolute, escaping or dangling links in a
// packed artifact would break installs on another machine.
function assertNoBadSymlinks(root) {
  const rootLexical = path.resolve(root);
  const rootResolved = fs.realpathSync(root);
  const isWithin = (parent, child) => {
    const rel = path.relative(parent, child);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const target = fs.readlinkSync(file);
      assert.ok(!path.isAbsolute(target), `absolute symlink in packed tree: ${file} -> ${target}`);
      const resolved = path.resolve(path.dirname(file), target);
      assert.ok(isWithin(rootLexical, resolved), `escaping symlink in packed tree: ${file} -> ${target}`);
      assert.ok(fs.existsSync(resolved), `dangling symlink in packed tree: ${file} -> ${target}`);
      const real = fs.realpathSync(resolved);
      assert.ok(
        isWithin(rootResolved, real),
        `symlink in packed tree resolves outside the tree: ${file} -> ${target} (${real})`,
      );
    }
  };
  walk(root);
}

// Fail if any regular file under root embeds one of the forbidden build paths
// as a byte string. pnpm shims once rewrote relative links into absolute
// release-temp paths, so no staged/extracted Foreman file may reference the
// release temp dir or the source worktree.
function assertNoEmbeddedBuildPaths(root, forbidden) {
  const needles = forbidden.map((p) => Buffer.from(path.resolve(p), 'utf8'));
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = fs.readFileSync(file);
      for (const needle of needles) {
        assert.ok(!bytes.includes(needle), `staged/extracted regular file embeds a build path: ${file}`);
      }
    }
  };
  walk(root);
}

function zipDirectory(source, destination) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    archive.pipe(output);
    archive.directory(source, false);
    void archive.finalize();
  });
}

test('packed-install E2E: no consumer-side Go compilation', {
  skip: ENABLED ? false : 'WRENYARD_SKIP_PACKED_INSTALL_E2E=1',
  timeout: E2E_TIMEOUT_MS,
}, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrenyard-packed-install-'));
  const fakeBin = path.join(tmp, 'fake-bin');
  const goLog = path.join(fakeBin, 'go.log');
  const releaseDir = path.join(tmp, 'release');
  const consumer = path.join(tmp, 'consumer');
  const prefix = path.join(tmp, 'prefix');

  // Fake `go` that logs its own invocation and fails: the point of the E2E is
  // to prove that no consumer install/run step shells out to a Go toolchain.
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeGo = path.join(fakeBin, process.platform === 'win32' ? 'go.cmd' : 'go');
  fs.writeFileSync(
    fakeGo,
    process.platform === 'win32'
      ? `@echo off\r\n>"${goLog}" echo FAKE_GO_INVOKED\r\necho fake go must not be invoked during consumer install/run 1>&2\r\nexit /b 42\r\n`
      : `#!/bin/sh\nprintf 'FAKE_GO_INVOKED\\n' > "${goLog.replace(/"/g, '\\"')}"\necho 'fake go must not be invoked during consumer install/run' >&2\nexit 42\n`,
    'utf8',
  );
  fs.chmodSync(fakeGo, 0o755);
  const consumerEnv = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` };

  try {
    // 1. Build the local release with desktop artifacts skipped. The source
    //    workspace install must come out byte-identical with the desktop
    //    runtime and every root dev dependency still available, and
    //    install.ps1 must keep replacing `current` through link-only removal.
    assertInstallPs1LinkOnlyRemoval(ROOT);
    const script = path.join(ROOT, 'tools', 'release', 'build-local-release.mjs');
    assert.ok(fs.existsSync(script), `release builder missing at ${script}`);
    const installSentinels = snapshotInstallSentinels(ROOT);
    run(process.execPath, [script, '--skip-desktop', '--output-dir', releaseDir], { cwd: ROOT });
    assert.ok(fs.readdirSync(releaseDir).length > 0, `release produced no output in ${releaseDir}`);
    assertInstallSentinelsUnchanged(ROOT, installSentinels);
    assert.ok(
      fs.existsSync(path.join(ROOT, 'apps', 'desktop', 'node_modules', 'electron')),
      'release build removed the desktop electron dependency',
    );
    assertRootDevDepsAvailable(ROOT);

    // 2. Discover and verify the release artifacts.
    const zipPath = findFile(releaseDir, /-suite\.zip$/);
    assert.ok(zipPath, 'suite zip not found in release output');
    assert.ok(
      new RegExp(`-${TRIPLET}-suite\\.zip$`).test(zipPath),
      `suite zip should be platform-qualified with ${TRIPLET}: ${path.basename(zipPath)}`,
    );
    const shaPath = `${zipPath}.sha256`;
    assert.ok(fs.existsSync(shaPath), `checksum sidecar not found: ${shaPath}`);
    assert.equal(sha256File(zipPath), readChecksum(shaPath), 'suite zip checksum mismatch');

    const tgz = findFile(releaseDir, /wrenyard-cli-.*\.tgz$/);
    assert.ok(tgz, 'CLI tarball not found in release output');

    // The minimal CLI tarball is a Foreman control package only: it must not
    // claim to contain the separately packaged Pet app, while the separately
    // emitted Pet Electron zip still ships the installable packaged app root
    // (Wrenyard Pet.app on macOS, or the platform-equivalent app root).
    const tgzListing = run('tar', ['-tzf', tgz]).stdout;
    assert.ok(
      !tgzListing.split(/\r?\n/).some((line) => /(^|\/)apps\/pet(\/|$)/.test(line)),
      `CLI tarball must not claim to contain apps/pet:\n${tgzListing}`,
    );
    const petZip = findFile(releaseDir, /wrenyard-pet-.*\.zip$/);
    assert.ok(petZip, 'separately emitted Pet Electron zip not found in release output');
    const petListing = run('unzip', ['-Z1', petZip]).stdout;
    const petAppRoot =
      process.platform === 'darwin'
        ? 'Wrenyard Pet.app/'
        : process.platform === 'win32'
          ? 'Wrenyard Pet.exe'
          : 'wrenyard-pet';
    assert.ok(
      petListing.split(/\r?\n/).some((line) => line.startsWith(petAppRoot)),
      `separately emitted Pet Electron zip must contain the installable packaged app root ${petAppRoot}:\n${petListing}`,
    );

    const sea = findFile(releaseDir, /(^|\/|\\)wrenyard-[^/\\]+-(darwin-arm64|darwin-x64|linux-x64|win32-x64)(\.exe)?$/);
    assert.ok(sea, 'standalone executable not found in release output');
    fs.chmodSync(sea, 0o755);

    // The suite zip must contain the wrenyard + forge executables and a release
    // manifest, matching what scripts/install.sh requires.
    const extractDir = path.join(tmp, 'suite-extract');
    fs.mkdirSync(extractDir, { recursive: true });
    if (hasCommand('unzip')) {
      run('unzip', ['-q', zipPath, '-d', extractDir]);
    } else {
      run('tar', ['-xf', zipPath, '-C', extractDir]);
    }
    const wrenyardInSuite = findFile(extractDir, /(^|\/|\\)wrenyard(\.exe)?$/);
    const forgeInSuite = findFile(extractDir, /(^|\/|\\)forge(\.exe)?$/);
    const manifestInSuite = findFile(extractDir, /(release-manifest|manifest)\.json$/);
    assert.ok(wrenyardInSuite, 'suite zip is missing the wrenyard executable');
    assert.ok(forgeInSuite, 'suite zip is missing the forge executable');
    assert.ok(manifestInSuite, 'suite zip is missing a release manifest');
    const nodeInSuite = findFile(extractDir, /(^|\/|\\)node(\.exe)?$/);
    assert.ok(nodeInSuite, 'suite zip is missing the packaged node runtime');
    const workspaceInSuite = findFile(extractDir, /(^|\/|\\)pnpm-workspace\.yaml$/);
    assert.ok(workspaceInSuite, 'suite zip is missing pnpm-workspace.yaml');

    // Deployed Foreman dependencies must be physical directories inside the
    // extracted tree (hoisted deploy), never symlinks into a build-time store.
    const deployedForemanManifest = JSON.parse(
      fs.readFileSync(path.join(extractDir, 'services', 'foreman', 'package.json'), 'utf8'),
    );
    assert.ok(deployedForemanManifest.dependencies, 'deployed foreman declares no dependencies');
    for (const dep of Object.keys(deployedForemanManifest.dependencies)) {
      assertPhysicalInsideTree(extractDir, path.join('services', 'foreman', 'node_modules', dep));
    }
    for (const dep of ['tsx', 'ajv', 'yaml', 'zod', 'better-sqlite3', '@langchain/core']) {
      assertPhysicalInsideTree(extractDir, path.join('services', 'foreman', 'node_modules', dep));
    }

    // The packed suite tree must keep only internal relative symlinks:
    // absolute, escaping or dangling links would break the install on another
    // machine (regression: staging copies once rewrote relative `.bin` links
    // to absolute build-temp paths).
    assertNoBadSymlinks(extractDir);
    // The release target has no workspace runtime dependencies: the extracted
    // Foreman tree must contain no @wrenyard self-link or virtual-store entry.
    assertNoWorkspaceLinks(path.join(extractDir, 'services', 'foreman'));
    // The deployed tree is a portable runtime, not a package-manager workspace:
    // neither pnpm-lock.yaml nor pnpm-workspace.yaml may ship in the extracted
    // services/foreman.
    assertNoPnpmWorkspaceMetadata(path.join(extractDir, 'services', 'foreman'));
    // The staged Foreman tree deliberately ships no .bin directory at any
    // depth: every launcher resolves tsx through an explicit path, and pnpm
    // shims are what historically leaked absolute build-temp paths (regression:
    // staging copies once rewrote relative .bin links to absolute build-temp
    // paths).
    assertNoBinDirs(path.join(extractDir, 'services', 'foreman'));
    // No regular staged file may embed the release temp dir or the source
    // worktree as a byte string.
    assertNoEmbeddedBuildPaths(path.join(extractDir, 'services', 'foreman'), [tmp, ROOT]);

    // Stage a real `forge` (if the suite ships one) so the installed CLI's
    // runtime command can find it on PATH during the run step.
    if (forgeInSuite) {
      const stagedForge = path.join(fakeBin, 'forge');
      fs.copyFileSync(forgeInSuite, stagedForge);
      fs.chmodSync(stagedForge, 0o755);
    }

    const version = readVersion(manifestInSuite, zipPath);

    // 3. Install the actual CLI tarball into a consumer project with lifecycle
    //    scripts disabled, then exercise the installed binary.
    fs.mkdirSync(consumer, { recursive: true });
    fs.writeFileSync(
      path.join(consumer, 'package.json'),
      JSON.stringify({ name: 'wrenyard-consumer', version: '0.0.0', private: true }, null, 2),
      'utf8',
    );
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tgz], { cwd: consumer, env: consumerEnv });

    const installed = path.join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'wrenyard.cmd' : 'wrenyard');
    assert.ok(fs.existsSync(installed), 'installed wrenyard launcher not found');
    run(installed, ['version'], { env: consumerEnv });
    run(installed, ['help'], { env: consumerEnv });
    run(installed, ['runtime', '--version'], { env: consumerEnv });

    // The CLI package must ship the pinned Node runtime (hidden under
    // .wrenyard/runtime) and run Foreman through it after moving away from the
    // build temp directory.
    const cliPkgDir = path.join(consumer, 'node_modules', '@wrenyard', 'cli');
    assert.ok(
      fs.existsSync(path.join(cliPkgDir, '.wrenyard', 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')),
      'CLI tarball is missing the packaged node runtime',
    );
    // Only `wrenyard` is a public launcher: the Foreman control and the native
    // Forge runtime are internal pieces of the package, never public bin
    // entries, so the npm shims must not exist.
    const installedForeman = path.join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'foreman.cmd' : 'foreman');
    const installedForgeShim = path.join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'forge.cmd' : 'forge');
    assert.ok(!fs.existsSync(installedForeman), 'foreman must not be a public bin entry; only wrenyard is public');
    assert.ok(!fs.existsSync(installedForgeShim), 'forge must not be a public bin entry; only wrenyard is public');

    // Installed status must launch internal control through the packaged node:
    // put a fake failing `node` first on PATH and run the Foreman status
    // handler through the package's bundled Node + tsx (the same invocation the
    // installed CLI launcher uses to spawn control). The handler exits 1 only
    // because no daemon is running in the consumer project, and the fake PATH
    // node proves the packaged node, not a PATH node, did the work.
    const fakeNodeDir = path.join(tmp, 'fake-node');
    fs.mkdirSync(fakeNodeDir, { recursive: true });
    const fakeNode = path.join(fakeNodeDir, 'node');
    fs.writeFileSync(
      fakeNode,
      '#!/bin/sh\necho "fake node must not be invoked; installed status uses the bundled node" >&2\nexit 42\n',
      'utf8',
    );
    fs.chmodSync(fakeNode, 0o755);
    const isolatedStatusConfig = path.join(tmp, 'installed-status-config.json');
    fs.writeFileSync(isolatedStatusConfig, JSON.stringify({
      service: {
        bind: '127.0.0.1:58473',
        ipc: { path: path.join(tmp, 'installed-status.sock') },
      },
      workspace: {},
      pet: { enabled: false },
    }), 'utf8');
    const noPathNodeEnv = {
      ...consumerEnv,
      PATH: `${fakeNodeDir}${path.delimiter}${consumerEnv.PATH}`,
      WRENYARD_CONFIG_HOME: path.join(tmp, 'installed-config'),
      WRENYARD_STATE_HOME: path.join(tmp, 'installed-state'),
    };
    const bundledNode = path.join(cliPkgDir, '.wrenyard', 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
    const statusRes = spawnSync(bundledNode, [
      path.join(cliPkgDir, 'services', 'foreman', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(cliPkgDir, 'services', 'foreman', 'bin', 'foreman.mts'),
      'status',
      '--config',
      isolatedStatusConfig,
    ], { env: noPathNodeEnv, encoding: 'utf8' });
    assert.notEqual(
      statusRes.status,
      0,
      `installed status should exit nonzero without a daemon (stdout: ${statusRes.stdout}, stderr: ${statusRes.stderr})`,
    );
    assert.match(
      `${statusRes.stdout}\n${statusRes.stderr}`,
      /Wrenyard status[\s\S]*daemon:\s+not running/,
      'installed status did not reach the Foreman status handler through the bundled node',
    );

    // The manual tgz must carry Foreman's direct dependency graph into the
    // installed package as physical directories: npm keeps real hoisted
    // directories shipped inside a tarball's node_modules (and prunes
    // virtual-store symlink entries), so the supported contract is that each
    // key entry is a physical directory resolving inside the installed package
    // before the installed Foreman is executed through the bundled Node
    // runtime.
    for (const dep of ['tsx', 'ajv', 'yaml', 'zod', 'better-sqlite3', '@langchain/core']) {
      assertPhysicalInsideTree(cliPkgDir, path.join('services', 'foreman', 'node_modules', dep));
    }

    // The installed CLI tree must likewise keep only internal relative
    // symlinks after the tarball is extracted into the consumer project, its
    // staged Foreman tree must carry no @wrenyard workspace entries, and it
    // must ship no node_modules/.bin or regular file embedding a build path.
    assertNoBadSymlinks(cliPkgDir);
    assertNoWorkspaceLinks(path.join(cliPkgDir, 'services', 'foreman'));
    assertNoPnpmWorkspaceMetadata(path.join(cliPkgDir, 'services', 'foreman'));
    assertNoBinDirs(path.join(cliPkgDir, 'services', 'foreman'));
    assertNoEmbeddedBuildPaths(path.join(cliPkgDir, 'services', 'foreman'), [tmp, ROOT]);

    // 4. Run the standalone executable directly.
    run(sea, ['version'], { env: consumerEnv });
    run(sea, ['help'], { env: consumerEnv });

    // 5. Serve the suite zip + sidecar over local HTTP and run scripts/install.sh
    //    into a temp prefix, then run the installed binary through the launcher.
    const server = http.createServer((req, res) => {
      const name = path.basename(req.url ?? '/');
      const file = name.endsWith('.sha256') ? shaPath : zipPath;
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Length': body.length });
      res.end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const zipUrl = `http://127.0.0.1:${port}/${path.basename(zipPath)}`;
      if (process.platform === 'win32') {
        await runAsync('powershell.exe', [
          '-NoProfile', '-File', path.join(ROOT, 'scripts', 'install.ps1'),
          '-Version', version,
          '-Url', zipUrl,
          '-ChecksumUrl', `${zipUrl}.sha256`,
          '-Prefix', prefix,
          '-BinDir', path.join(prefix, 'bin'),
        ], { env: consumerEnv });
      } else {
        await runAsync('bash', [
          path.join(ROOT, 'scripts', 'install.sh'),
          '--version', version,
          '--url', zipUrl,
          '--checksum-url', `${zipUrl}.sha256`,
          '--prefix', prefix,
          '--bin-dir', path.join(prefix, 'bin'),
        ], { env: consumerEnv });
      }

      const launcher = path.join(prefix, 'bin', process.platform === 'win32' ? 'wrenyard.cmd' : 'wrenyard');
      assert.ok(fs.existsSync(launcher), 'installed launcher symlink not found');
      assert.ok(fs.existsSync(path.join(prefix, 'current')), 'current link not found');
      run(launcher, ['version'], { env: consumerEnv });
      run(launcher, ['help'], { env: consumerEnv });
      // Only wrenyard is a public launcher: the internal Foreman control and
      // the native Forge runtime stay hidden inside the installed suite.
      const foremanLauncher = path.join(prefix, 'bin', process.platform === 'win32' ? 'foreman.cmd' : 'foreman');
      const forgeLauncher = path.join(prefix, 'bin', process.platform === 'win32' ? 'forge.cmd' : 'forge');
      assert.ok(!fs.existsSync(foremanLauncher), 'foreman must not be a public launcher; only wrenyard is public');
      assert.ok(!fs.existsSync(forgeLauncher), 'forge must not be a public launcher; only wrenyard is public');

      // Installed commands must work on a bare PATH with no Node/Go/pnpm.
      if (process.platform !== 'win32') {
        const bareEnv = { ...consumerEnv, PATH: '/usr/bin:/bin' };
        run(launcher, ['version'], { env: bareEnv });
        run(launcher, ['help'], { env: bareEnv });
      }

      // 5a. Reinstall integrity: rerunning the same checksummed install must
      // replace tampered content inside an existing version directory from the
      // verified archive (the installer never reuses a version dir) and leave
      // the commands runnable afterwards.
      const installedVersionDir = path.join(prefix, 'versions', version);
      assert.ok(fs.existsSync(installedVersionDir), 'installed version directory not found');
      const tamperTarget = findFile(installedVersionDir, /(^|\/|\\)wrenyard(\.exe)?$/);
      assert.ok(tamperTarget, 'installed version contains no wrenyard executable to tamper');
      const pristineBytes = fs.readFileSync(tamperTarget);
      const tamperMarker = 'TAMPERED-BY-REINSTALL-INTEGRITY-TEST';
      fs.writeFileSync(tamperTarget, tamperMarker);
      if (process.platform === 'win32') {
        await runAsync('powershell.exe', [
          '-NoProfile', '-File', path.join(ROOT, 'scripts', 'install.ps1'),
          '-Version', version,
          '-Url', zipUrl,
          '-ChecksumUrl', `${zipUrl}.sha256`,
          '-Prefix', prefix,
          '-BinDir', path.join(prefix, 'bin'),
        ], { env: consumerEnv });
      } else {
        await runAsync('bash', [
          path.join(ROOT, 'scripts', 'install.sh'),
          '--version', version,
          '--url', zipUrl,
          '--checksum-url', `${zipUrl}.sha256`,
          '--prefix', prefix,
          '--bin-dir', path.join(prefix, 'bin'),
        ], { env: consumerEnv });
      }
      assert.notDeepEqual(
        fs.readFileSync(tamperTarget),
        Buffer.from(tamperMarker),
        'reinstall reused tampered content from the existing version directory',
      );
      assert.deepEqual(
        fs.readFileSync(tamperTarget),
        pristineBytes,
        'reinstall did not replace tampered content from the verified archive',
      );
      run(launcher, ['version'], { env: consumerEnv });
      run(launcher, ['help'], { env: consumerEnv });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    // 5b. POSIX --update path: a fake `curl` placed on a restricted PATH serves
    // the releases-list JSON (with stable, prerelease and draft entries), the
    // built zip and its checksum sidecar. install.sh --update must select the
    // newest non-draft release (a v1.0.0-dev.* prerelease here), never the
    // draft, and must use the private-release token through a mode-0600 netrc
    // file without ever echoing it.
    if (process.platform !== 'win32') {
      assert.ok(
        TRIPLET === 'darwin-arm64' || TRIPLET === 'darwin-x64' || TRIPLET === 'linux-x64',
        `--update E2E requires a darwin/linux host, got ${process.platform}-${process.arch}`,
      );
      const fakeCurlDir = path.join(tmp, 'fake-curl');
      const curlLog = path.join(fakeCurlDir, 'curl.log');
      fs.mkdirSync(fakeCurlDir, { recursive: true });
      const fakeCurl = path.join(fakeCurlDir, 'curl');
      fs.writeFileSync(fakeCurl, `#!/bin/sh
url=""
out=""
prev=""
netrc=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; prev=""; continue; fi
  if [ "$prev" = "--netrc-file" ]; then netrc="$a"; prev=""; continue; fi
  case "$a" in
    -o) prev="-o" ;;
    --netrc-file) prev="--netrc-file" ;;
    https://*|http://*) url="$a" ;;
  esac
done
printf '%s\\n' "$url" >> "$FAKE_CURL_LOG"
if [ -n "$netrc" ] && [ -n "$FAKE_CURL_TOKEN" ]; then
  if grep -q "$FAKE_CURL_TOKEN" "$netrc"; then printf 'AUTH_OK\\n' >> "$FAKE_CURL_LOG"; else printf 'AUTH_MISSING\\n' >> "$FAKE_CURL_LOG"; fi
fi
case "$url" in
  *releases?per_page=*|*releases\\?per_page=*)
    if [ -n "$out" ]; then cat "$FAKE_CURL_RELEASES" > "$out"; else cat "$FAKE_CURL_RELEASES"; fi ;;
  *.sha256)
    if [ -n "$out" ]; then cat "$FAKE_CURL_SHA" > "$out"; else cat "$FAKE_CURL_SHA"; fi ;;
  *)
    if [ -n "$out" ]; then cat "$FAKE_CURL_ZIP" > "$out"; else cat "$FAKE_CURL_ZIP"; fi ;;
esac
`, 'utf8');
      fs.chmodSync(fakeCurl, 0o755);

      const releasesPath = path.join(tmp, 'releases.json');
      fs.writeFileSync(releasesPath, `[
  {
    "url": "https://api.github.com/repos/wrenyard/wrenyard/releases/3",
    "tag_name": "v9.9.9-draft",
    "draft": true,
    "prerelease": false,
    "published_at": "2026-08-15T00:00:00Z"
  },
  {
    "url": "https://api.github.com/repos/wrenyard/wrenyard/releases/2",
    "tag_name": "v9.9.9-rc.9",
    "draft": false,
    "prerelease": true,
    "published_at": "2026-08-14T09:00:00Z"
  },
  {
    "url": "https://api.github.com/repos/wrenyard/wrenyard/releases/1",
    "tag_name": "v9.9.8",
    "draft": false,
    "prerelease": false,
    "published_at": "2026-08-01T00:00:00Z"
  }
]
`, 'utf8');

      // Restricted PATH: fake curl plus /usr/bin:/bin only. No Node, Go, pnpm
      // or any toolchain is available to the installer or the installed CLI.
      const updatePrefix = path.join(tmp, 'update-prefix');
      const updateEnv = {
        ...consumerEnv,
        PATH: `${fakeCurlDir}${path.delimiter}/usr/bin:/bin`,
        FAKE_CURL_LOG: curlLog,
        FAKE_CURL_RELEASES: releasesPath,
        FAKE_CURL_ZIP: zipPath,
        FAKE_CURL_SHA: shaPath,
      };

      // Step A: explicit --version install of the built release. The fake curl
      // serves the real suite zip for any asset URL derived from the version.
      await runAsync('bash', [
        path.join(ROOT, 'scripts', 'install.sh'),
        '--version', version,
        '--prefix', updatePrefix,
        '--bin-dir', path.join(updatePrefix, 'bin'),
      ], { env: updateEnv });

      // Step B: --update with a private-release token. The releases-list must
      // select the newest non-draft entry (v9.9.9-rc.9), skipping the draft
      // that was published later, and the token must authenticate via the
      // mode-0600 netrc file without appearing anywhere in the output.
      const token = `ghp_${'x'.repeat(36)}`;
      const updateAuthEnv = { ...updateEnv, GH_TOKEN: token, FAKE_CURL_TOKEN: token };
      fs.writeFileSync(curlLog, '');
      const updateResult = await runAsync('bash', [
        path.join(ROOT, 'scripts', 'install.sh'),
        '--update',
        '--prefix', updatePrefix,
        '--bin-dir', path.join(updatePrefix, 'bin'),
      ], { env: updateAuthEnv });

      const requested = fs.readFileSync(curlLog, 'utf8').trim().split('\n');
      assert.ok(
        requested.some((line) => line.includes('releases?per_page=')),
        'install.sh --update must query the releases list (not /releases/latest)',
      );
      assert.ok(requested.includes('AUTH_OK'), 'private-release token was not sent via the netrc file');
      const asset = requested.find((line) => line.includes('-suite.zip'));
      assert.ok(asset, 'fake curl recorded no suite zip request during --update');
      assert.ok(
        asset.includes(`-9.9.9-rc.9-${TRIPLET}-suite.zip`),
        `--update must select the newest non-draft dev release and the ${TRIPLET} asset: ${asset}`,
      );
      assert.ok(
        !asset.includes('9.9.9-draft'),
        `--update must never select a draft release: ${asset}`,
      );
      const combinedOutput = `${updateResult.stdout}\n${updateResult.stderr}`;
      assert.ok(
        !combinedOutput.includes(token),
        'install.sh must never echo the private-release token',
      );

      const updateCurrent = path.join(updatePrefix, 'current');
      assert.equal(
        fs.readlinkSync(updateCurrent),
        path.join(updatePrefix, 'versions', '9.9.9-rc.9'),
        '--update current link should point at the newly installed dev version',
      );
      assert.ok(
        fs.existsSync(path.join(updatePrefix, 'versions', version)),
        'previous version must be retained for rollback after --update',
      );
      const updateLauncher = path.join(updatePrefix, 'bin', 'wrenyard');
      assert.ok(fs.existsSync(updateLauncher), '--update installed launcher not found');
      run(updateLauncher, ['version'], { env: updateEnv });
      run(updateLauncher, ['help'], { env: updateEnv });
      assert.ok(
        !fs.existsSync(path.join(updatePrefix, 'bin', 'foreman')),
        'foreman must not be a public launcher; only wrenyard is public',
      );
      assert.ok(
        !fs.existsSync(path.join(updatePrefix, 'bin', 'forge')),
        'forge must not be a public launcher; only wrenyard is public',
      );

      // Step C: rollback by reinstalling the retained previous version; the
      // atomic current switch must return to it and the launcher must work.
      await runAsync('bash', [
        path.join(ROOT, 'scripts', 'install.sh'),
        '--version', version,
        '--prefix', updatePrefix,
        '--bin-dir', path.join(updatePrefix, 'bin'),
      ], { env: updateEnv });
      assert.equal(
        fs.readlinkSync(updateCurrent),
        path.join(updatePrefix, 'versions', version),
        'rollback reinstall should restore the previous version as current',
      );
      run(updateLauncher, ['version'], { env: updateEnv });
      run(updateLauncher, ['help'], { env: updateEnv });
    }

    // 5c. A checksum mismatch must reject the install atomically: nothing is
    // written into the prefix and no launcher is wired.
    if (process.platform !== 'win32') {
      const badShaPath = path.join(tmp, 'bad-sha.txt');
      fs.writeFileSync(badShaPath, `${'0'.repeat(64)}  suite.zip\n`);
      const badServer = http.createServer((req, res) => {
        const name = path.basename(req.url ?? '/');
        const file = name.endsWith('.sha256') ? badShaPath : zipPath;
        const body = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Length': body.length });
        res.end(body);
      });
      await new Promise((resolve) => badServer.listen(0, '127.0.0.1', resolve));
      try {
        const port = badServer.address().port;
        const url = `http://127.0.0.1:${port}/${path.basename(zipPath)}`;
        const badPrefix = path.join(tmp, 'bad-sha-prefix');
        await assert.rejects(
          runAsync('bash', [
            path.join(ROOT, 'scripts', 'install.sh'),
            '--version', version,
            '--url', url,
            '--checksum-url', `${url}.sha256`,
            '--prefix', badPrefix,
            '--bin-dir', path.join(badPrefix, 'bin'),
          ], { env: consumerEnv }),
          /checksum mismatch/,
        );
        assert.ok(
          !fs.existsSync(path.join(badPrefix, 'current')),
          'checksum-rejected install must not create a current link',
        );
        assert.ok(
          !fs.existsSync(path.join(badPrefix, 'bin', 'wrenyard')),
          'checksum-rejected install must not wire a launcher',
        );
      } finally {
        await new Promise((resolve) => badServer.close(resolve));
      }
    }

    // 6. The fake `go` must never have been invoked during any consumer step.
    assert.ok(!fs.existsSync(goLog), 'fake go was invoked during a consumer install/run step');

    console.log(`packed-install E2E ok: version=${version} zip=${path.basename(zipPath)} tgz=${path.basename(tgz)} sea=${path.basename(sea)} prefix=${prefix}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
