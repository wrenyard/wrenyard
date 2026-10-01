#!/usr/bin/env node
// Canonical local/CI packaging entry. It builds this platform's Desktop
// installer and smokes the assembled application. It never publishes, never
// mutates tracked files and never writes a version commit; release.mjs wraps it
// with version bookkeeping. Running on a tag validates the tag against the root
// version (a mismatched tag fails closed before any output is produced).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { entryFor } from './platform.mjs';
import { packageVersion, releaseTagFromEnv, validateDevTag, validateNativeTarget } from './release-context.mjs';
import { scanText } from '../check-secrets.mjs';

const RELEASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(RELEASE_DIR, '..', '..');
const target = entryFor();
const PACK_DIR = path.join(ROOT, '.artifacts', 'pack');
// electron-builder copies this staging tree from `extraResources` into
// <resources>/wrenyard of the packaged app.
const STAGE_DIR = path.join(PACK_DIR, 'wrenyard');
const OUTPUT_DIR = path.join(ROOT, 'release');
// Keep <resources>\wrenyard\** under 240 chars on Windows without LongPathsEnabled.
const MAX_SUITE_RELATIVE_PATH = 180;

function run(command, args, options = {}) {
  console.log(`[pack] $ ${command} ${args.join(' ')}`);
  const windowsPackageManager = process.platform === 'win32' && (command === 'pnpm' || command === 'npm');
  // `replaceEnv` starts from the supplied env alone; the default merge would
  // re-add inherited process.env keys the caller deliberately deleted.
  const env = options.replaceEnv ? { ...(options.env ?? {}) } : { ...process.env, ...(options.env ?? {}) };
  for (const key of options.unsetEnv ?? []) delete env[key];
  const result = spawnSync(windowsPackageManager ? `${command}.cmd` : command, args, {
    cwd: options.cwd ?? ROOT, env, encoding: 'utf8', shell: windowsPackageManager,
    timeout: options.timeoutMs ?? 0, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.split(/\r?\n/u).map((line) => line.trim()).join('\n').trim().slice(-16000);
    throw new Error(`${command} exited ${result.status}${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout ?? '';
}
// Best-effort git query; returns undefined when git is unavailable or fails.
function gitStdout(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout ?? '';
}
// A real tag at HEAD must be v<root version>. A prior release's tag (whose
// committed manifest version differs from the working-tree version, the state
// while release.mjs packs before committing a bump) is not authoritative.
function validateHeadTag(version) {
  const names = (gitStdout(['tag', '--points-at', 'HEAD']) ?? '').split('\n').map((name) => name.trim()).filter(Boolean);
  for (const name of names) {
    const manifest = gitStdout(['show', `${name}:package.json`]);
    if (manifest === undefined) continue;
    let committed;
    try { committed = JSON.parse(manifest).version; } catch { continue; }
    if (committed !== version) continue;
    validateDevTag(name, version);
  }
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
function copyFile(source, destination, mode) {
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
  if (mode !== undefined) fs.chmodSync(destination, mode);
}
// Nearest `node_modules/<name>` visible from `fromDir`, following Node's lookup.
function findPackageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) return undefined;
  }
}
// Copies the production dependency closure of `roots` out of the build host's
// installed tree into `nodeModules`, hoisted where versions agree and nested
// where they differ. Installed native binaries are copied as built.
export function copyDependencyClosure(roots, nodeModules) {
  const hoistedVersions = new Map();
  const copyPackage = (source, target) => fs.cpSync(source, target, {
    recursive: true, force: true, dereference: true,
    filter: (entry) => {
      const name = path.basename(entry);
      if (name === 'node_modules' || name === '.bin') return false;
      return path.dirname(entry) !== source || !['test', 'tests', '__tests__'].includes(name);
    },
  });
  const visit = (name, fromDir, parentModules, optional) => {
    const source = findPackageDir(name, fromDir);
    if (!source) {
      if (optional) return;
      throw new Error(`cannot resolve ${name} from ${fromDir}`);
    }
    const { version, dependencies = {}, optionalDependencies = {} } = readJson(path.join(source, 'package.json'));
    const hoisted = hoistedVersions.get(name);
    if (hoisted === version) return;
    const target = path.join(hoisted === undefined ? nodeModules : parentModules, ...name.split('/'));
    if (fs.existsSync(target)) return;
    if (hoisted === undefined) hoistedVersions.set(name, version);
    copyPackage(source, target);
    const childModules = hoisted === undefined ? nodeModules : path.join(target, 'node_modules');
    for (const dependency of Object.keys(dependencies)) visit(dependency, source, childModules, false);
    for (const dependency of Object.keys(optionalDependencies)) visit(dependency, source, childModules, true);
  };
  for (const [name, fromDir] of roots) visit(name, fromDir, nodeModules, false);
}
// Every installed package directory under `nodeModules`, nested ones included.
function installedPackageDirs(nodeModules) {
  const dirs = [];
  const walk = (modules) => {
    if (!fs.existsSync(modules)) return;
    for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(modules, entry.name);
      const packages = entry.name.startsWith('@')
        ? fs.readdirSync(dir, { withFileTypes: true }).filter((child) => child.isDirectory()).map((child) => path.join(dir, child.name))
        : [dir];
      for (const pkg of packages) {
        dirs.push(pkg);
        walk(path.join(pkg, 'node_modules'));
      }
    }
  };
  walk(nodeModules);
  return dirs;
}
// Dependency source maps and type declarations are never loaded at runtime.
const DEPENDENCY_DEV_ONLY_FILE = /\.(?:map|d\.[cm]?ts)$/u;
function pruneDependencyDevFiles(root) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && DEPENDENCY_DEV_ONLY_FILE.test(entry.name)) fs.rmSync(file);
    }
  };
  walk(root);
}
// Native packages keep their compiled binary and JS entry only: no C/C++
// sources, intermediate build output or other platforms' prebuilds.
function pruneNativePackages(nodeModules) {
  const platformDir = `${process.platform}-${process.arch}`;
  const removeExcept = (dir, keep) => {
    if (!fs.existsSync(dir)) return;
    for (const child of fs.readdirSync(dir)) if (!keep(child)) fs.rmSync(path.join(dir, child), { recursive: true, force: true });
  };
  for (const pkg of installedPackageDirs(nodeModules)) {
    if (!fs.existsSync(path.join(pkg, 'binding.gyp'))) continue;
    for (const name of ['deps', 'src', 'third_party', 'scripts']) fs.rmSync(path.join(pkg, name), { recursive: true, force: true });
    removeExcept(path.join(pkg, 'build'), (child) => child === 'Release');
    removeExcept(path.join(pkg, 'build', 'Release'), (child) => child.endsWith('.node'));
    removeExcept(path.join(pkg, 'prebuilds'), (child) => child === platformDir || child === `${platformDir}.node`);
  }
}
// Resolve the pinned Node runtime from the root `node` dependency, not execPath.
function pinnedNodeBinary() {
  const require = createRequire(import.meta.url);
  const manifestFile = require.resolve('node/package.json');
  const bin = readJson(manifestFile).bin ?? {};
  const relative = (process.platform === 'win32' ? (bin['node.exe'] ?? bin.node) : bin.node) ?? Object.values(bin)[0];
  if (!relative) throw new Error('root node package declares no binary in package.json bin');
  return path.join(path.dirname(manifestFile), relative);
}
function walkRelativeFiles(root, visit) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) visit(path.relative(root, file).split(path.sep).join('/'));
    }
  };
  walk(root);
}
// The win32 payload must contain zero symlinks.
export function assertNoSymlinks(root, label) {
  const violations = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) violations.push(path.relative(root, file));
      else if (entry.isDirectory()) walk(file);
    }
  };
  walk(root);
  if (violations.length > 0) throw new Error(`${label} tree contains symlinks:\n${violations.join('\n')}`);
}
// contracts/versions.json is the suite root marker and must appear exactly once.
export function assertSingleSuiteMarker(root) {
  const markers = [];
  walkRelativeFiles(root, (rel) => { if (rel.endsWith('contracts/versions.json')) markers.push(rel); });
  if (markers.length !== 1 || markers[0] !== 'contracts/versions.json') {
    throw new Error(`suite must contain exactly one contracts/versions.json, found: ${markers.join(', ') || 'none'}`);
  }
}
// Enforce the Windows path budget; the failure reports the measured maximum.
export function assertSuitePathLengths(root, limit = MAX_SUITE_RELATIVE_PATH) {
  const violations = [];
  let max = 0;
  let maxPath = '';
  walkRelativeFiles(root, (rel) => {
    if (rel.length > max) [max, maxPath] = [rel.length, rel];
    if (rel.length > limit) violations.push(`${rel.length}: ${rel}`);
  });
  if (violations.length > 0) throw new Error(`suite relative path exceeds ${limit} characters (max ${max}: ${maxPath}):\n${violations.slice(0, 10).join('\n')}`);
  return { max, maxPath };
}
const FORBIDDEN_PAYLOAD_NAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.npmrc', '.yarnrc', '.yarnrc.yml', '.netrc', '.pgpass', '.git-credentials', '.htpasswd']);
const FORBIDDEN_PAYLOAD_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk', '.asc', '.db', '.sqlite', '.sqlite3', '.log']);
const FORBIDDEN_PAYLOAD_DIRS = new Set(['.git', '.gnupg', '.ssh', 'agent-workspace']);
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u;
// A path is a dependency tree when its last node_modules segment is not @wrenyard.
const isDependencyPath = (segments) => {
  const index = segments.lastIndexOf('node_modules');
  return index >= 0 && segments[index + 1] !== '@wrenyard';
};
// Byte variants (raw, slash/backslash and JSON-escaped) for one path candidate.
function pathByteVariants(candidate) {
  const values = new Set();
  for (const raw of [candidate, path.resolve(candidate)]) {
    for (const value of [raw, raw.replaceAll('\\', '/'), raw.replaceAll('/', '\\'), raw.replaceAll('\\', '\\\\'), raw.replaceAll('/', '\\\\')]) values.add(value);
  }
  return [...values].filter((value) => value.length > 3).map((value) => Buffer.from(value));
}
// Exact build paths are rejected everywhere; developer-home values only in first-party files.
function payloadNeedles(buildTmp, worktree) {
  const collect = (candidates) => {
    const values = new Set();
    for (const candidate of candidates) if (candidate) for (const bytes of pathByteVariants(candidate)) values.add(bytes);
    return [...values];
  };
  return { build: collect([buildTmp, worktree]), home: collect([os.homedir(), process.env.HOME, process.env.USERPROFILE]) };
}
// Bounded staged-payload gate; it reports only the path and rule, never a value.
export function assertSafeReleasePayload(stage, label, buildTmp, worktree) {
  const root = path.resolve(stage);
  const { build, home } = payloadNeedles(buildTmp, worktree);
  const violations = [];
  const report = (file, rule) => violations.push(`${path.relative(root, file)}: ${rule}`);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const segments = path.relative(root, file).split(path.sep);
      if (entry.isSymbolicLink()) continue;
      if (segments.some((segment) => FORBIDDEN_PAYLOAD_DIRS.has(segment))) { report(file, 'forbidden private/workspace payload directory'); continue; }
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      const ext = path.extname(lower);
      const dependency = isDependencyPath(segments);
      if (FORBIDDEN_PAYLOAD_NAMES.has(lower)) { report(file, 'forbidden user credential/config file'); continue; }
      const bytes = fs.readFileSync(file);
      const text = bytes.includes(0) ? null : bytes.toString('utf8');
      const publicCertificate = dependency && ext === '.pem' && text
        && /^\s*-----BEGIN CERTIFICATE-----[\s\S]*-----END CERTIFICATE-----\s*$/.test(text) && !text.includes('PRIVATE KEY');
      if (FORBIDDEN_PAYLOAD_EXTENSIONS.has(ext) && !publicCertificate) { report(file, 'forbidden credential/secret/database/log file'); continue; }
      if (ext === '.map' && !dependency) report(file, 'source map payload forbidden');
      if (build.some((needle) => bytes.includes(needle)) || (!dependency && home.some((needle) => bytes.includes(needle)))) report(file, 'embeds a local developer/home/checkout absolute path');
      if (!text) continue;
      const findings = scanText(text).filter((finding) => !dependency || (finding.detector === 'pem-private-key' && PRIVATE_KEY_BLOCK.test(text)));
      if (findings.length) report(file, `secret signature detected (${[...new Set(findings.map((f) => f.detector))].join(', ')})`);
    }
  };
  walk(root);
  if (violations.length) throw new Error(`unsafe staged ${label} payload:\n${violations.join('\n')}`);
}
// Desktop extraResources layout: SEA CLI, pinned Node, the daemon bundle tree,
// the suite root marker and legal files. Bootstrap scripts, release-manifest
// and pnpm workspace files are deliberately absent.
function writeStage(stage, version, sea) {
  copyFile(sea, path.join(stage, `wrenyard${target.exeSuffix}`), 0o755);
  copyFile(pinnedNodeBinary(), path.join(stage, 'runtime', `node${target.exeSuffix}`), 0o755);
  copyFile(path.join(ROOT, 'contracts', 'versions.json'), path.join(stage, 'contracts', 'versions.json'));
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) copyFile(path.join(ROOT, name), path.join(stage, name));
  fs.writeFileSync(path.join(stage, 'SUITE_VERSION'), `${version}\n`);
}
// Build the SEA bundle consumed by build-sea.mjs, then the SEA executable.
function buildSea(tmp) {
  run(process.execPath, [path.join(ROOT, 'apps', 'cli', 'tools', 'build.mjs')], { cwd: path.join(ROOT, 'apps', 'cli') });
  const sea = path.join(tmp, `wrenyard${target.exeSuffix}`);
  run(process.execPath, [path.join(RELEASE_DIR, 'build-sea.mjs'), '--cli', path.join(ROOT, 'apps', 'cli', 'dist', 'wrenyard-sea.cjs'), '--output', sea]);
  return sea;
}
// daemon/: the daemon bundle, its external-dependency manifest and only those
// external packages (native modules and the DSH runtime it loads from disk).
export function stageDaemon(stage) {
  run('pnpm', ['--filter', '@wrenyard/daemon', 'run', 'build']);
  const bundle = path.join(ROOT, 'apps', 'daemon', 'dist');
  const daemonDir = path.join(stage, 'daemon');
  copyFile(path.join(bundle, 'daemon.mjs'), path.join(daemonDir, 'daemon.mjs'));
  copyFile(path.join(bundle, 'package.json'), path.join(daemonDir, 'package.json'));
  const nodeModules = path.join(daemonDir, 'node_modules');
  const session = path.join(ROOT, 'packages', 'features', 'session');
  const { dependencies } = readJson(path.join(bundle, 'package.json'));
  copyDependencyClosure([
    ...Object.keys(dependencies).map((name) => [name, name === 'better-sqlite3' ? path.join(ROOT, 'packages', 'execution') : session]),
  ], nodeModules);
  pruneDependencyDevFiles(nodeModules);
  pruneNativePackages(nodeModules);
}
// Build the Desktop bundle, then let electron-builder produce this platform's
// installer(s). The artifact names are driven by WRENYARD_RELEASE_TRIPLET so no
// Chinese product name ever appears in a public asset.
function buildInstaller() {
  run('pnpm', ['--filter', '@wrenyard/desktop', 'run', 'build']);
  const flag = process.platform === 'darwin' ? '--mac' : '--win';
  run('pnpm', ['--filter', '@wrenyard/desktop', 'exec', 'electron-builder', flag, '--publish', 'never'], {
    env: { WRENYARD_RELEASE_TRIPLET: target.triplet },
  });
}
// The installers this platform's pack run must produce.
export function expectedArtifactNames(version, triplet = target.triplet) {
  return triplet === 'win32-x64'
    ? [`wrenyard-desktop-${version}-win32-x64-setup.exe`]
    : [`wrenyard-desktop-${version}-darwin-arm64.dmg`, `wrenyard-desktop-${version}-darwin-arm64.zip`];
}
function assertArtifacts(outputDir, version) {
  for (const name of expectedArtifactNames(version)) {
    if (!fs.existsSync(path.join(outputDir, name))) throw new Error(`electron-builder produced no ${name} in ${outputDir}`);
  }
}
// Locate the unpacked application electron-builder assembled before packaging.
function findAssembledApp(releaseDir, triplet = target.triplet) {
  const dirs = fs.readdirSync(releaseDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (triplet === 'win32-x64') {
    const unpacked = dirs.find((entry) => entry.name === 'win-unpacked');
    if (!unpacked) throw new Error('Desktop build produced no win-unpacked application');
    return path.join(releaseDir, unpacked.name);
  }
  for (const entry of dirs) {
    if (!entry.name.startsWith('mac')) continue;
    const dir = path.join(releaseDir, entry.name);
    const app = fs.readdirSync(dir, { withFileTypes: true }).find((child) => child.isDirectory() && child.name.endsWith('.app'));
    if (app) return path.join(dir, app.name);
  }
  throw new Error('Desktop build produced no macOS application bundle');
}
// The SEA inside the assembled app, resolved through the documented layout.
export function packagedSeaPath(appDir, triplet = target.triplet) {
  const resources = triplet === 'darwin-arm64' ? path.join(appDir, 'Contents', 'Resources') : path.join(appDir, 'resources');
  const sea = path.join(resources, 'wrenyard', `wrenyard${triplet === 'win32-x64' ? '.exe' : ''}`);
  if (!fs.existsSync(sea)) throw new Error(`assembled app is missing the bundled CLI: ${sea}`);
  return sea;
}
// Inherited daemon pointers from a developer shell or a Wrenyard task must
// never reach the isolated smoke.
const INHERITED_SMOKE_KEYS = [
  'WRENYARD_IPC_PATH', 'FOREMAN_TASK_RUN_ID',
  'FOREMAN_DB_PATH', 'FOREMAN_OPENCODE_BIN', 'HOST', 'PORT',
];
// Isolated HOME/XDG dirs plus a private config with an explicit IPC path, so the
// smoke never touches a developer's real daemon or config. The gateway binds a
// random port, so only the IPC path and workspace root are isolated. The config
// keys mirror apps/daemon/lib/config normalize (service.ipc.path, workspace.root).
function isolatedSmokeEnv(homeDir) {
  const configHome = path.join(homeDir, 'config', 'wrenyard');
  const stateHome = path.join(homeDir, 'state');
  const workspaceRoot = path.join(homeDir, 'workspace');
  ensureDir(configHome);
  ensureDir(stateHome);
  ensureDir(workspaceRoot);
  const ipcPath = target.triplet === 'win32-x64'
    ? `\\\\.\\pipe\\wrenyard-pack-${process.pid}`
    : path.join(homeDir, 'ipc', 'wrenyard.sock');
  if (target.triplet !== 'win32-x64') ensureDir(path.dirname(ipcPath));
  const config = {
    service: { ipc: { path: ipcPath } },
    workspace: { root: workspaceRoot },
  };
  const configPath = path.join(configHome, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, 'config'),
    XDG_DATA_HOME: path.join(homeDir, 'data'),
    XDG_CACHE_HOME: path.join(homeDir, 'cache'),
    XDG_STATE_HOME: stateHome,
    LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local'),
    APPDATA: path.join(homeDir, 'AppData', 'Roaming'),
    WRENYARD_CONFIG_HOME: configHome,
    WRENYARD_CONFIG: configPath,
    WRENYARD_STATE_HOME: stateHome,
    WRENYARD_WORK_DIR: workspaceRoot,
    WRENYARD_WORKSPACE: workspaceRoot,
    WRENYARD_TEST_WORK_DIR: workspaceRoot,
  };
  for (const key of INHERITED_SMOKE_KEYS) delete env[key];
  return env;
}
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

// The last JSON object printed by a `--json` command, tolerating any leading
// informational lines.
function parseTrailingJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`expected JSON output, got: ${JSON.stringify(text.slice(0, 200))}`);
  return JSON.parse(text.slice(start, end + 1));
}
// The CLI health contract (apps/cli/src/commands/status.mts): only an accepted
// structured status counts as healthy.
function statusHealthy(status) {
  return status?.ok === true && status?.daemon?.running === true && status?.ipc?.ok === true;
}
// Resolve true when the child has really exited within `timeoutMs`.
function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}
function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolveWait(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(childExited(child)), timeoutMs);
    child.once('exit', onExit);
  });
}
// Smoke the assembled application through its bundled SEA: `--version` must be
// the target version on the first line, and the bundled control tree must run a
// foreground `daemon run` whose `daemon status --json` contract reports healthy.
// The daemon is an owned child here; the smoke stops it over IPC and awaits the
// real exit instead of using the removed detached `daemon start`.
export async function smokeAssembledApp(seaPath, version, homeDir) {
  const env = isolatedSmokeEnv(homeDir);
  const smoke = (args, timeoutMs) => run(seaPath, args, { env, replaceEnv: true, timeoutMs });
  const versionOutput = smoke(['--version'], 30_000).trim();
  if (versionOutput.split('\n')[0]?.trim() !== `wrenyard ${version}`) {
    throw new Error(`packaged CLI reported the wrong version: ${JSON.stringify(versionOutput)}`);
  }
  const child = spawn(seaPath, ['daemon', 'run'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  child.stdout?.on('data', (chunk) => { output = (output + chunk).slice(-8192); });
  child.stderr?.on('data', (chunk) => { output = (output + chunk).slice(-8192); });
  const deadline = Date.now() + 60_000;
  let lastError;
  try {
    for (;;) {
      if (spawnError) throw spawnError;
      if (childExited(child)) {
        throw new Error(`daemon run exited before readiness (code ${child.exitCode ?? 'none'}); output:\n${output.slice(-2000)}`);
      }
      try {
        const status = parseTrailingJson(smoke(['daemon', 'status', '--json'], 30_000));
        if (statusHealthy(status)) return;
        lastError = new Error(`isolated daemon is not healthy: ${JSON.stringify(status).slice(0, 500)}`);
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) throw lastError;
      await delay(2_000);
    }
  } finally {
    // Always attempt the isolated stop, even when readiness only partially
    // succeeded, then await the owned child's real exit.
    try {
      smoke(['daemon', 'stop'], 60_000);
    } catch (error) {
      console.error(`[pack] isolated daemon stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (child.pid !== undefined && !(await waitForChildExit(child, 30_000))) {
      child.kill();
      await waitForChildExit(child, 5_000);
    }
  }
}

async function main() {
  const version = packageVersion();
  const tag = releaseTagFromEnv();
  if (tag) validateDevTag(tag, version);
  validateHeadTag(version);
  validateNativeTarget(target.triplet);
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.rmSync(PACK_DIR, { recursive: true, force: true });
  ensureDir(PACK_DIR);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrenyard-pack-'));
  try {
    const sea = buildSea(tmp);
    stageDaemon(STAGE_DIR);
    writeStage(STAGE_DIR, version, sea);
    assertNoSymlinks(STAGE_DIR, 'payload');
    assertSingleSuiteMarker(STAGE_DIR);
    const measured = assertSuitePathLengths(STAGE_DIR);
    console.log(`[pack] longest payload relative path: ${measured.max} characters (${measured.maxPath})`);
    assertSafeReleasePayload(STAGE_DIR, 'payload', tmp, ROOT);
    buildInstaller();
    assertArtifacts(OUTPUT_DIR, version);
    const appDir = findAssembledApp(OUTPUT_DIR);
    // The final assembled app must be symlink-free too, not only the stage tree.
    if (target.triplet === 'win32-x64') assertNoSymlinks(appDir, 'assembled app');
    await smokeAssembledApp(packagedSeaPath(appDir), version, path.join(tmp, 'smoke-home'));
    console.log(`[pack] built ${version} for ${target.triplet} in ${OUTPUT_DIR}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(PACK_DIR, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[pack] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
