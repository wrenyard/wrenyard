#!/usr/bin/env node
// Canonical local/CI release build: emits the portable suite zip and, unless
// --skip-desktop, the Desktop zip, each with a local .sha256 sidecar. It never
// publishes; platform and tag validation are folded in here for CI.
import archiver from 'archiver';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { entryFor } from './platform.mjs';
import { packageVersion, releaseTagFromEnv, validateDevTag, validateNativeTarget } from './release-context.mjs';
import { scanText } from '../check-secrets.mjs';
const RELEASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(RELEASE_DIR, '..', '..');
const target = entryFor();
const STAGED_CONTROL_ROOT = 'apps/cli';
// Keep <prefix>\versions\<v>\<rel> under 240 chars on Windows without LongPathsEnabled.
const MAX_SUITE_RELATIVE_PATH = 180;
const DEPLOY_SOURCES = [path.join('apps', 'cli'), path.join('apps', 'daemon'), 'packages'];
function parseArgs(argv) {
  const options = { outputDir: path.join(ROOT, '.artifacts', 'release'), skipDesktop: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--skip-desktop') options.skipDesktop = true;
    else if (arg === '--output-dir' || arg.startsWith('--output-dir=')) {
      const inline = arg.startsWith('--output-dir=');
      const value = inline ? arg.slice(13) : argv[i + 1];
      if (!value) throw new Error('--output-dir requires a value');
      options.outputDir = path.resolve(value);
      if (!inline) i += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}
function run(command, args, options = {}) {
  console.log(`[release] $ ${command} ${args.join(' ')}`);
  const windowsPackageManager = process.platform === 'win32' && (command === 'pnpm' || command === 'npm');
  const env = { ...process.env, ...(options.env ?? {}) };
  for (const key of options.unsetEnv ?? []) delete env[key];
  const result = spawnSync(windowsPackageManager ? `${command}.cmd` : command, args, {
    cwd: options.cwd ?? ROOT, env, encoding: 'utf8', shell: windowsPackageManager, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().slice(-8000);
    throw new Error(`${command} exited ${result.status}${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout ?? '';
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const writeSidecar = (file) => fs.writeFileSync(`${file}.sha256`, `${sha256(file)}  ${path.basename(file)}\n`);
// The build emits one suite archive and, unless skipped, one Desktop archive.
export function artifactNames(version, triplet, skipDesktop = false) {
  return {
    suite: `wrenyard-${version}-${triplet}-suite.zip`,
    desktop: skipDesktop ? null : `wrenyard-desktop-${version}-${triplet}.zip`,
  };
}
function copyFile(source, destination, mode) {
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
  if (mode !== undefined) fs.chmodSync(destination, mode);
}
function copyDirWithoutNodeModules(source, destination) {
  fs.cpSync(source, destination, { recursive: true, force: true, verbatimSymlinks: true, filter: (entry) => path.basename(entry) !== 'node_modules' });
}
function newestElectronAppDir(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).map((name) => path.join(dir, name))
    .filter((entry) => fs.statSync(entry).isDirectory() && /(?:^mac(?:-|$)|win-unpacked$|linux-unpacked$)/u.test(path.basename(entry)))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
}
// ditto is the native macOS archiver and matches the installer's `ditto -x -k`.
async function zipDirectory(source, destination) {
  if (process.platform === 'darwin') {
    run('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noacl', source, destination]);
    return;
  }
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    archive.pipe(output);
    archive.directory(source, false);
    void archive.finalize();
  });
}
// Remove pnpm deploy-only metadata; the deployed tree needs no build-host state.
function stripDeployMetadata(deploy) {
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml', 'node_modules/.pnpm-workspace-state-v1.json']) {
    const file = path.join(deploy, name);
    fs.rmSync(file, { force: true });
    if (fs.existsSync(file)) throw new Error(`deployed control tree still contains ${name}: ${file}`);
  }
}
// pnpm deploy writes workspace dependencies as file: URLs into the build temp
// dir; pin them to the deployed package version so no build path ships.
function pinWorkspaceDependencySpecs(deploy) {
  const manifestPath = path.join(deploy, 'package.json');
  const manifest = readJson(manifestPath);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec !== 'string' || !/(^|@)(file|link):/.test(spec)) continue;
      manifest[field][name] = readJson(path.join(deploy, 'node_modules', ...name.split('/'), 'package.json')).version;
    }
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
// Dependency source maps and type declarations are never loaded at runtime.
const DEPENDENCY_DEV_ONLY_FILE = /\.(?:map|d\.[cm]?ts)$/u;
function pruneDependencyDevFiles(deploy) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && DEPENDENCY_DEV_ONLY_FILE.test(entry.name) && isDependencyPath(path.relative(deploy, file).split(path.sep))) fs.rmSync(file);
    }
  };
  walk(path.join(deploy, 'node_modules'));
}
// Every shipped launcher resolves tsx explicitly, so no .bin shim may survive.
function removeBinDirs(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    if (entry.name === '.bin') fs.rmSync(file, { recursive: true, force: true });
    else removeBinDirs(file);
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
// The suite (and the win32 Desktop tree) must contain zero symlinks.
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
// Run the staged control entry the SEA delegates to, under an isolated HOME/XDG
// with WRENYARD_ROOT unset.
export function assertStagedControlRuns(stage, homeDir) {
  const node = path.join(stage, 'runtime', `node${target.exeSuffix}`);
  const tsx = path.join(stage, STAGED_CONTROL_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  for (const [name, file] of [['node', node], ['tsx', tsx]]) {
    if (!fs.existsSync(file)) throw new Error(`staged suite control entry missing ${name}: ${file}`);
  }
  ensureDir(homeDir);
  const env = { HOME: homeDir, XDG_CONFIG_HOME: path.join(homeDir, '.config'), XDG_DATA_HOME: path.join(homeDir, '.local', 'share'), XDG_CACHE_HOME: path.join(homeDir, '.cache') };
  const source = 'apps/cli/src/index.mts';
  const file = path.join(stage, source);
  if (!fs.existsSync(file)) throw new Error(`staged suite control entry missing: ${source}`);
  if (!run(node, [tsx, file, '--help'], { env, unsetEnv: ['WRENYARD_ROOT'] }).trim()) throw new Error(`staged suite control ${source} --help printed no output`);
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
// Suite root layout: bootstrap scripts, docs/release, release-manifest.json,
// pnpm-workspace.yaml and the suite manifest schema are deliberately absent.
// The control tree is deployed in place at <stage>/apps/cli beforehand.
function writeSuiteStage(stage, version, sea) {
  copyFile(sea, path.join(stage, `wrenyard${target.exeSuffix}`), 0o755);
  copyFile(pinnedNodeBinary(), path.join(stage, 'runtime', `node${target.exeSuffix}`), 0o755);
  copyFile(path.join(ROOT, 'contracts', 'versions.json'), path.join(stage, 'contracts', 'versions.json'));
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) copyFile(path.join(ROOT, name), path.join(stage, name));
  fs.writeFileSync(path.join(stage, 'SUITE_VERSION'), `${version}\n`);
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = packageVersion();
  const tag = releaseTagFromEnv();
  if (tag) validateDevTag(tag, version);
  validateNativeTarget(target.triplet);
  const outputDir = options.outputDir;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrenyard-release-'));
  fs.rmSync(outputDir, { recursive: true, force: true });
  ensureDir(outputDir);
  try {
    run('pnpm', ['--filter', '@wrenyard/cli', 'build']);
    const sea = path.join(tmp, `wrenyard${target.exeSuffix}`);
    run(process.execPath, [path.join(RELEASE_DIR, 'build-sea.mjs'), '--cli', path.join(ROOT, 'apps', 'cli', 'dist', 'wrenyard-sea.cjs'), '--output', sea]);
    const suiteStage = path.join(tmp, 'suite');
    const controlDeploy = path.join(suiteStage, STAGED_CONTROL_ROOT);
    const deployWorkspace = path.join(tmp, 'deploy-workspace');
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) copyFile(path.join(ROOT, name), path.join(deployWorkspace, name));
    for (const rel of DEPLOY_SOURCES) copyDirWithoutNodeModules(path.join(ROOT, rel), path.join(deployWorkspace, rel));
    run('pnpm', ['--config.node-linker=hoisted', '--config.package-import-method=copy', '--filter', '@wrenyard/cli', 'deploy', '--prod', controlDeploy], { cwd: deployWorkspace });
    stripDeployMetadata(controlDeploy);
    pinWorkspaceDependencySpecs(controlDeploy);
    removeBinDirs(controlDeploy);
    pruneDependencyDevFiles(controlDeploy);
    writeSuiteStage(suiteStage, version, sea);
    assertNoSymlinks(suiteStage, 'suite');
    assertSingleSuiteMarker(suiteStage);
    const measured = assertSuitePathLengths(suiteStage);
    console.log(`[release] longest suite relative path: ${measured.max} characters (${measured.maxPath})`);
    assertStagedControlRuns(suiteStage, path.join(tmp, 'home'));
    assertSafeReleasePayload(suiteStage, 'suite', tmp, ROOT);
    const names = artifactNames(version, target.triplet, options.skipDesktop);
    const suiteZip = path.join(outputDir, names.suite);
    await zipDirectory(suiteStage, suiteZip);
    writeSidecar(suiteZip);
    if (names.desktop) {
      run('pnpm', ['--filter', '@wrenyard/desktop', 'dist:release']);
      const built = newestElectronAppDir(path.join(ROOT, 'apps', 'desktop', 'release'));
      if (!built) throw new Error('Desktop build produced no unpacked application');
      if (process.platform === 'win32') assertNoSymlinks(built, 'desktop');
      const desktopZip = path.join(outputDir, names.desktop);
      await zipDirectory(built, desktopZip);
      writeSidecar(desktopZip);
    }
    console.log(`[release] built ${version} for ${target.triplet} in ${outputDir}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[release] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
