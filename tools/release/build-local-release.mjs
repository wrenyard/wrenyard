#!/usr/bin/env node
// Canonical local/CI release pipeline. It builds only the current host target,
// never publishes, and writes a CLI tarball (one public wrenyard launcher, with
// the Foreman control and the native/bundled runtimes hidden), precompiled
// Forge runtime tarball, Node SEA executable, portable suite zip, optional
// Desktop zip, Pet zip, the embedded development identity, legal report,
// checksums and a target-qualified artifact manifest to one output directory.

import archiver from 'archiver';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { entryFor } from './platform.mjs';

const RELEASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(RELEASE_DIR, '..', '..');
const target = entryFor();

function parseArgs(argv) {
  const options = {
    outputDir: path.join(ROOT, '.artifacts', 'release'),
    skipDesktop: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--skip-desktop') options.skipDesktop = true;
    else if (arg === '--output-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--output-dir requires a value');
      options.outputDir = path.resolve(value);
      index += 1;
    } else if (arg.startsWith('--output-dir=')) {
      options.outputDir = path.resolve(arg.slice('--output-dir='.length));
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/release/build-local-release.mjs [--output-dir DIR] [--skip-desktop]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function run(command, args, options = {}) {
  console.log(`[release] $ ${command} ${args.join(' ')}`);
  const windowsPackageManager = process.platform === 'win32' && (command === 'pnpm' || command === 'npm');
  const executable = windowsPackageManager ? `${command}.cmd` : command;
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    shell: windowsPackageManager,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().slice(-8000);
    throw new Error(`${command} exited ${result.status}${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout ?? '';
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(source, destination, mode) {
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
  if (mode !== undefined) fs.chmodSync(destination, mode);
}

function copyDir(source, destination) {
  fs.cpSync(source, destination, { recursive: true, force: true, verbatimSymlinks: true });
}

function copyDirWithoutNodeModules(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: (entry) => path.basename(entry) !== 'node_modules',
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function newestElectronAppDir(dir) {
  if (!fs.existsSync(dir)) return null;
  const candidates = fs.readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((entry) => fs.statSync(entry).isDirectory())
    .filter((entry) => /(?:^mac(?:-|$)|win-unpacked$|linux-unpacked$)/u.test(path.basename(entry)))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] ?? null;
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

// Recursively verify that every symlink in a deployed/staged tree is relative,
// resolves to a real path inside that tree and exists. Fail closed so a stray
// pnpm-store or absolute link can never ship inside a packed artifact.
function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function assertPortableTree(root) {
  const violations = [];
  // Canonicalize the stage root (macOS aliases /var to /private/var) before
  // comparing resolved symlink targets, and test containment with
  // path.relative, so in-tree links are never misread as escapes while real
  // escapes still fail closed.
  const rootLexical = path.resolve(root);
  const rootResolved = fs.realpathSync(root);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const target = fs.readlinkSync(file);
      if (path.isAbsolute(target)) {
        violations.push(`absolute symlink target: ${file} -> ${target}`);
        continue;
      }
      const resolved = path.resolve(path.dirname(file), target);
      if (!isWithin(rootLexical, resolved)) {
        violations.push(`symlink target escapes tree: ${file} -> ${target}`);
        continue;
      }
      if (!fs.existsSync(resolved)) {
        violations.push(`symlink target does not exist: ${file} -> ${target}`);
        continue;
      }
      const real = fs.realpathSync(resolved);
      if (!isWithin(rootResolved, real)) {
        violations.push(`symlink target resolves outside tree: ${file} -> ${target} (${real})`);
      }
    }
  };
  walk(root);
  if (violations.length > 0) {
    throw new Error(`portability assertion failed for ${root}:\n${violations.join('\n')}`);
  }
}

// Byte-snapshot the root pnpm install-state sentinels before a deploy so the
// release can prove afterwards that the workspace install is byte-identical
// (still a full dev install) and was never re-linked or pruned.
function snapshotWorkspaceInstallState(root) {
  const sentinels = [
    'node_modules/.modules.yaml',
    'node_modules/.pnpm-workspace-state-v1.json',
    'node_modules/.package-map.json',
  ];
  const snapshot = {};
  for (const rel of sentinels) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) {
      snapshot[rel] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  const nativeRoot = path.join(root, 'node_modules', '.pnpm');
  const snapshotNativeModules = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        snapshotNativeModules(file);
      } else if (entry.isFile() && entry.name.endsWith('.node')) {
        const rel = path.relative(root, file);
        snapshot[rel] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      }
    }
  };
  snapshotNativeModules(nativeRoot);
  return snapshot;
}

// Fail the release before anything is packed if any existing install sentinel
// changed or disappeared, or the parsed install state no longer describes a
// full dev workspace (all workspace projects, not a filtered/prod install).
function assertWorkspaceInstallStateUnchanged(root, snapshot) {
  const violations = [];
  for (const [rel, before] of Object.entries(snapshot)) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
      violations.push(`workspace install sentinel removed: ${rel}`);
      continue;
    }
    const after = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (after !== before) violations.push(`workspace install sentinel mutated: ${rel}`);
  }
  const stateFile = path.join(root, 'node_modules', '.pnpm-workspace-state-v1.json');
  if (fs.existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object') {
        violations.push('workspace install state unparseable after deploy');
      } else {
        const projects = parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : null;
        if (!projects || Object.keys(projects).length === 0) {
          violations.push('workspace install state no longer describes a full dev install (missing projects map)');
        } else {
          const present = new Set(Object.keys(projects).map((key) => path.resolve(key)));
          for (const dir of workspacePackageDirs(root)) {
            if (!present.has(path.resolve(dir))) {
              violations.push(`workspace install state dropped workspace package ${path.relative(root, dir) || '.'}`);
            }
          }
        }
        if (parsed.filteredInstall === true) {
          violations.push('workspace install state no longer describes a full dev install (filteredInstall)');
        }
        if (parsed.settings && parsed.settings.dev === false) {
          violations.push('workspace install state no longer describes a full dev install (settings.dev)');
        }
      }
    } catch (error) {
      violations.push(`workspace install state unparseable after deploy: ${error.message}`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`release deploy mutated the workspace install:\n${violations.join('\n')}`);
  }
}

// Absolute workspace member directories (root plus the apps/*, services/* and
// packages/* projects) used to prove the install state still covers the full
// dev set after the deploy.
function workspacePackageDirs(root) {
  const dirs = [root];
  for (const rel of ['apps', 'services', 'packages']) {
    const dir = path.join(root, rel);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'package.json'))) {
        dirs.push(path.join(dir, entry.name));
      }
    }
  }
  return dirs;
}

// The release target currently has no workspace runtime dependencies, so a
// deployed Foreman tree must never contain an @wrenyard self-link or a
// virtual-store entry for a workspace package. Fail closed if one appears.
// Entry-name checks use path.relative(root, file) so an ancestor/sibling path
// (for example a parent @wrenyard scope) can never make every child a
// violation while a real @wrenyard segment inside the inspected tree still
// fails.
function assertNoWorkspaceLinks(root) {
  const violations = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const rel = path.relative(root, file);
      if (rel.includes('@wrenyard')) {
        violations.push(`workspace entry staged: ${rel}`);
        continue;
      }
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const target = fs.readlinkSync(file);
      if (target.includes('@wrenyard')) violations.push(`workspace self-link staged: ${rel} -> ${target}`);
    }
  };
  walk(root);
  if (violations.length > 0) {
    throw new Error(`deployed Foreman tree contains @wrenyard workspace entries:\n${violations.join('\n')}`);
  }
}

// A modern isolated pnpm deploy writes deploy-root pnpm-lock.yaml and
// pnpm-workspace.yaml; those are deploy-only package-manager metadata, not part
// of the portable runtime tree. Remove only those two root files (the
// intentional product-root pnpm-workspace.yaml is copied into each stage
// separately) and fail closed if either survives.
function stripForemanDeployMetadata(deploy) {
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    const file = path.join(deploy, name);
    fs.rmSync(file, { force: true });
    if (fs.existsSync(file)) {
      throw new Error(`deployed Foreman tree still contains ${name}: ${file}`);
    }
  }
}

// Before the deployed Foreman tree is copied into any stage, every direct
// production dependency must exist as a physical hoisted directory, never a
// symlink. npm retains physical directories shipped inside a tarball's
// node_modules but prunes symlinked virtual-store entries, so the
// --config.node-linker=hoisted deploy plus this check guarantees the shipped
// dependency graph stays complete; the E2E repeats physical-directory
// containment checks after extraction and after npm install.
function assertPhysicalForemanDependencies(deploy) {
  const direct = ['tsx', 'ajv', 'yaml', 'zod', 'better-sqlite3', '@langchain/core'];
  const violations = [];
  for (const dep of direct) {
    const entry = path.join(deploy, 'node_modules', dep);
    if (!fs.existsSync(entry)) {
      violations.push(`${dep}: missing`);
      continue;
    }
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) {
      violations.push(`${dep}: symlink (expected physical directory)`);
      continue;
    }
    if (!stat.isDirectory()) {
      violations.push(`${dep}: not a directory`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`deployed Foreman direct dependencies are not physical directories:\n${violations.join('\n')}`);
  }
}

// The deploy root is the Foreman package itself: pnpm's isolated deploy writes
// the package and its production node_modules directly at <deploy>/node_modules.
// The deployed tree must never ship pnpm's .bin shim directory: every shipped
// launcher invokes tsx through an explicit path, and the .bin dir is what
// historically rewrote relative links into absolute build-temp paths. Modern
// pnpm layouts also nest shims at deeper depths (for example
// .pnpm/<pkg>/node_modules/.bin), so the removal walks the whole deploy tree.
function removeForemanBinDir(deploy) {
  removeNestedBinDirs(deploy);
  assertNoForemanBinDir(deploy, 'deploy');
}

// Recursively remove every directory whose basename is exactly `.bin` under
// root, including nested `.pnpm/**/node_modules/.bin` shims, before any stage
// copy. No other file is touched.
function removeNestedBinDirs(root) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      if (entry.name === '.bin') {
        fs.rmSync(file, { recursive: true, force: true });
        continue;
      }
      walk(file);
    }
  };
  walk(root);
}

// Fail closed if any directory named `.bin` remains anywhere in the Foreman
// tree, not only the top-level node_modules/.bin.
function assertNoForemanBinDir(foremanRoot, label) {
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
  if (violations.length > 0) {
    throw new Error(`${label} Foreman tree still contains pnpm .bin shims:\n${violations.join('\n')}`);
  }
}

// Fail closed if any regular file inside a staged Foreman runtime embeds the
// canonical release build temp path or the source worktree as byte strings.
// The scan complements the symlink containment checks: even without .bin
// shims, an absolute build path written into file content would break the
// packed artifacts on another machine.
function assertNoBuildPathsInStagedForeman(stage, label, buildTmp, worktree) {
  const needles = [path.resolve(buildTmp), path.resolve(worktree)].map((p) => Buffer.from(p, 'utf8'));
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
        if (bytes.includes(needle)) {
          throw new Error(`staged ${label} Foreman file embeds a build path: ${file}`);
        }
      }
    }
  };
  walk(path.join(stage, 'services', 'foreman'));
}

// Run the real staged Foreman entry through the staged Node runtime and tsx to
// prove the artifact-contained Foreman actually executes before it is emitted.
// nodeRelPath locates the staged bundled node (the CLI package hides it under
// .wrenyard/runtime while the suite keeps it at runtime/).
function assertStagedForemanRuns(stage, label, nodeRelPath) {
  const node = path.join(stage, nodeRelPath, `node${target.exeSuffix}`);
  const tsx = path.join(stage, 'services', 'foreman', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const source = path.join(stage, 'services', 'foreman', 'bin', 'foreman.mts');
  for (const [name, file] of [['node', node], ['tsx', tsx], ['foreman.mts', source]]) {
    if (!fs.existsSync(file)) throw new Error(`staged ${label} Foreman entry missing ${name}: ${file}`);
  }
  const output = run(node, [tsx, source, '--version']);
  if (!output || !output.trim()) throw new Error(`staged ${label} Foreman entry printed no --version output`);
}

// Resolve the pinned Node runtime binary from the root `node` dependency
// (declared pinned at node@22.19.0) instead of process.execPath, so every
// shipped CLI/suite runtime is exactly the documented pinned Node and never
// captures whatever Node happened to run the release pipeline. The lookup
// mirrors build-sea.mjs: createRequire resolves the `node` package's
// package.json and the binary path comes from its `bin` field (node.exe on
// Windows).
function pinnedNodeBinary() {
  const require = createRequire(import.meta.url);
  const manifestFile = require.resolve('node/package.json');
  const manifest = readJson(manifestFile);
  const bin = manifest.bin ?? {};
  const entry = process.platform === 'win32' ? (bin['node.exe'] ?? bin.node) : bin.node;
  const relative = entry ?? Object.values(bin)[0];
  if (!relative) throw new Error('root node package declares no binary in package.json bin');
  return path.join(path.dirname(manifestFile), relative);
}

function cliLauncher(version, versions) {
  return `#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { main } from '../dist/wrenyard.mjs';
const suiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forge = path.join(suiteRoot, '.wrenyard', 'runtime', ${JSON.stringify(`forge${target.exeSuffix}`)});
process.env.WRENYARD_FORGE_BIN ??= forge;
  process.exitCode = main(process.argv.slice(2), {
  suiteRoot,
  nodeExecutable: path.join(suiteRoot, '.wrenyard', 'runtime', ${JSON.stringify(`node${target.exeSuffix}`)}),
  suiteVersion: ${JSON.stringify(version)},
  componentVersions: ${JSON.stringify(versions)},
});
`;
}

// nodeRelPath is the runtime subdirectory the launcher spawns the bundled Node
// from: the CLI package hides it under .wrenyard/runtime while the suite keeps
// it at the top-level runtime/ that scripts/install.sh validates.
function foremanLauncher(nodeRelPath) {
  return `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(root, 'services', 'foreman', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const source = path.join(root, 'services', 'foreman', 'bin', 'foreman.mts');
const result = spawnSync(path.join(root, ${JSON.stringify(nodeRelPath)}, ${JSON.stringify(`node${target.exeSuffix}`)}), [tsx, source, ...process.argv.slice(2)], {
  stdio: 'inherit', shell: false, env: process.env,
});
if (result.error) console.error('foreman launcher failed:', result.error.message);
process.exitCode = result.error ? 1 : (result.status ?? 1);
`;
}

// The npm package exposes exactly one public launcher (wrenyard); the Foreman
// control launcher, the native Forge runtime and the bundled Node runtime are
// hidden under .wrenyard so they never surface as extra public bin commands.
function writePackageStage(stage, version, versions, cliDist, runtimeStage, foremanDeploy) {
  ensureDir(path.join(stage, 'bin'));
  ensureDir(path.join(stage, 'dist'));
  ensureDir(path.join(stage, '.wrenyard', 'control'));
  ensureDir(path.join(stage, '.wrenyard', 'runtime'));
  fs.writeFileSync(path.join(stage, 'bin', 'wrenyard.mjs'), cliLauncher(version, versions));
  fs.writeFileSync(path.join(stage, '.wrenyard', 'control', 'foreman.mjs'), foremanLauncher('.wrenyard/runtime'));
  fs.chmodSync(path.join(stage, 'bin', 'wrenyard.mjs'), 0o755);
  fs.chmodSync(path.join(stage, '.wrenyard', 'control', 'foreman.mjs'), 0o755);
  copyFile(cliDist, path.join(stage, 'dist', 'wrenyard.mjs'));
  copyFile(path.join(runtimeStage, 'bin', `forge${target.exeSuffix}`), path.join(stage, '.wrenyard', 'runtime', `forge${target.exeSuffix}`), 0o755);
  copyFile(pinnedNodeBinary(), path.join(stage, '.wrenyard', 'runtime', `node${target.exeSuffix}`), 0o755);
  copyDir(foremanDeploy, path.join(stage, 'services', 'foreman'));
  copyDir(path.join(ROOT, 'contracts'), path.join(stage, 'contracts'));
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'release-manifest.json', 'pnpm-workspace.yaml']) {
    copyFile(path.join(ROOT, name), path.join(stage, name));
  }
  const manifest = {
    name: '@wrenyard/cli',
    version,
    description: 'Wrenyard unified CLI with a precompiled host Forge runtime.',
    type: 'module',
    license: 'MIT',
    os: [process.platform],
    cpu: [process.arch],
    bin: { wrenyard: './bin/wrenyard.mjs' },
    files: ['bin', 'dist', '.wrenyard', 'services', 'contracts', 'release-manifest.json', 'pnpm-workspace.yaml', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'],
    engines: { node: '>=22.19.0' },
  };
  fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeSuiteStage(stage, version, sea, runtimeStage, foremanDeploy) {
  ensureDir(path.join(stage, 'bin'));
  const seaName = `wrenyard${target.exeSuffix}`;
  copyFile(sea, path.join(stage, seaName), 0o755);
  copyFile(path.join(runtimeStage, 'bin', `forge${target.exeSuffix}`), path.join(stage, 'bin', `forge${target.exeSuffix}`), 0o755);
  copyFile(pinnedNodeBinary(), path.join(stage, 'runtime', `node${target.exeSuffix}`), 0o755);
  fs.writeFileSync(path.join(stage, 'bin', 'foreman.mjs'), foremanLauncher('runtime'));
  fs.chmodSync(path.join(stage, 'bin', 'foreman.mjs'), 0o755);
  if (process.platform !== 'win32') {
    fs.writeFileSync(path.join(stage, 'bin', 'foreman'), `#!/bin/sh
# Symlink-safe launcher: resolve every symlink in $0 (absolute or relative
# link targets) so it works through <prefix>/bin/foreman -> <prefix>/current/bin/foreman.
script=$0
while [ -L "$script" ]; do
  dir=$(dirname "$script")
  target=$(readlink "$script")
  case "$target" in
    /*) script=$target ;;
    *) script=$dir/$target ;;
  esac
done
real_dir=$(dirname "$script")
exec "$real_dir/../runtime/node" "$real_dir/foreman.mjs" "$@"
`);
    fs.chmodSync(path.join(stage, 'bin', 'foreman'), 0o755);
  }
  copyDir(foremanDeploy, path.join(stage, 'services', 'foreman'));
  copyDir(path.join(ROOT, 'contracts'), path.join(stage, 'contracts'));
  copyDir(path.join(ROOT, 'docs', 'release'), path.join(stage, 'docs', 'release'));
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'release-manifest.json', 'pnpm-workspace.yaml']) {
    copyFile(path.join(ROOT, name), path.join(stage, name));
  }
  copyFile(path.join(ROOT, 'scripts', 'install.sh'), path.join(stage, 'install.sh'), 0o755);
  copyFile(path.join(ROOT, 'scripts', 'install.ps1'), path.join(stage, 'install.ps1'));
  fs.writeFileSync(path.join(stage, 'SUITE_VERSION'), `${version}\n`);
}

function pack(stage, outputDir) {
  const stdout = run('npm', ['pack', '--pack-destination', outputDir], { cwd: stage });
  const name = stdout.trim().split(/\r?\n/).at(-1);
  if (!name) throw new Error(`npm pack produced no filename for ${stage}`);
  const file = path.join(outputDir, name);
  if (!fs.existsSync(file)) throw new Error(`npm pack output missing: ${file}`);
  return file;
}

// Cross-platform npm-compatible writer for the CLI tarball. It walks the
// staged tree with lstat in sorted order and emits `package/`-prefixed POSIX
// entries (directories, regular files and relative symlinks), rejecting
// absolute, dangling or escaping links before they are serialized. This
// replaces `npm pack` for the CLI tgz so the artifact can be produced on any
// host without depending on the local npm/tar behaviour, while npm install
// still preserves the archive's own node_modules and its portable top-level
// dependency symlinks.
function packCliTgz(stage, outputDir, version) {
  const destination = path.join(outputDir, `wrenyard-cli-${version}-${target.triplet}.tgz`);
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination);
    const archive = archiver('tar', { gzip: true, gzipOptions: { level: 9 } });
    output.once('close', () => resolve(destination));
    output.once('error', reject);
    archive.once('error', reject);
    archive.pipe(output);

    const root = path.resolve(stage);
    const rootReal = fs.realpathSync(root);
    const isWithin = (parent, child) => {
      const rel = path.relative(parent, child);
      return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    };
    const entryPath = (abs) => `package/${path.relative(root, abs).split(path.sep).join('/')}`;

    archive.append(Buffer.alloc(0), { name: 'package/', type: 'directory' });
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir).sort()) {
        const abs = path.join(dir, name);
        const stat = fs.lstatSync(abs);
        if (stat.isDirectory()) {
          archive.append(Buffer.alloc(0), { name: entryPath(abs), type: 'directory', mode: stat.mode & 0o7777 });
          walk(abs);
        } else if (stat.isSymbolicLink()) {
          const target = fs.readlinkSync(abs);
          if (path.isAbsolute(target)) throw new Error(`absolute symlink entry: ${abs} -> ${target}`);
          const resolved = path.resolve(path.dirname(abs), target);
          if (!isWithin(root, resolved)) throw new Error(`symlink entry escapes tree: ${abs} -> ${target}`);
          if (!fs.existsSync(resolved)) throw new Error(`dangling symlink entry: ${abs} -> ${target}`);
          const real = fs.realpathSync(resolved);
          if (!isWithin(rootReal, real)) throw new Error(`symlink entry resolves outside tree: ${abs} -> ${target} (${real})`);
          archive.symlink(entryPath(abs), target, stat.mode & 0o7777);
        } else if (stat.isFile()) {
          archive.append(fs.createReadStream(abs), { name: entryPath(abs), mode: stat.mode & 0o7777 });
        }
      }
    };
    walk(root);
    void archive.finalize();
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = options.outputDir;
  const rootPackage = readJson(path.join(ROOT, 'package.json'));
  const versions = readJson(path.join(ROOT, 'contracts', 'versions.json'));
  const version = rootPackage.version;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrenyard-release-'));

  fs.rmSync(outputDir, { recursive: true, force: true });
  ensureDir(outputDir);
  try {
    run('pnpm', ['release:check']);
    run('pnpm', ['--filter', '@wrenyard/cli', 'build']);

    const runtimeStage = path.join(tmp, 'runtime');
    run(process.execPath, [path.join(RELEASE_DIR, 'build-runtime-package.mjs'), '--output-dir', runtimeStage]);

    const sea = path.join(outputDir, `wrenyard-${version}-${target.triplet}${target.exeSuffix}`);
    run(process.execPath, [
      path.join(RELEASE_DIR, 'build-sea.mjs'),
      '--cli', path.join(ROOT, 'apps', 'cli', 'dist', 'wrenyard-sea.cjs'),
      '--output', sea,
    ]);

    const foremanDeploy = path.join(tmp, 'foreman');
    // Deploy with pnpm's shared-lockfile isolated linker, keeping the workspace
    // context cleared (no --legacy) so the source workspace install stays
    // byte-identical, but overriding node-linker to "hoisted" for this single
    // invocation so the temporary deploy under <temp> gets physical hoisted
    // dependency directories that npm retains when installing the tarball. The
    // deploy output is copied below with verbatimSymlinks:true and
    // assertPortableTree verifies the tree contains only internal relative
    // links. The pnpm .bin shim directory is removed right after the deploy
    // because every shipped launcher resolves tsx through an explicit path and
    // the .bin dir is what historically rewrote relative links into absolute
    // build-temp paths.
    const installSnapshot = snapshotWorkspaceInstallState(ROOT);
    // Run deploy from a minimal isolated workspace. Both modern and legacy
    // deploy update install metadata, and modern deploy may rebuild hoisted
    // native modules; neither operation is allowed to touch the live source
    // workspace that is developing Wrenyard itself.
    const deployWorkspace = path.join(tmp, 'deploy-workspace');
    ensureDir(path.join(deployWorkspace, 'services'));
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      copyFile(path.join(ROOT, name), path.join(deployWorkspace, name));
    }
    copyDirWithoutNodeModules(
      path.join(ROOT, 'services', 'foreman'),
      path.join(deployWorkspace, 'services', 'foreman'),
    );
    run('pnpm', [
      '--config.node-linker=hoisted',
      '--config.package-import-method=copy',
      '--filter', '@wrenyard/foreman',
      'deploy', '--prod', foremanDeploy,
    ], { cwd: deployWorkspace });
    // Strip the deploy-only root pnpm-lock.yaml and pnpm-workspace.yaml a
    // modern hoisted deploy generates before any CLI/suite copy, and fail
    // closed if either remains: embedded services/foreman is a portable runtime
    // tree, while the intentional product-root pnpm-workspace.yaml is copied
    // into each stage separately.
    stripForemanDeployMetadata(foremanDeploy);
    assertWorkspaceInstallStateUnchanged(ROOT, installSnapshot);
    assertPortableTree(foremanDeploy);
    // The release target currently has no workspace runtime dependencies;
    // reject any staged @wrenyard self-link or virtual-store entry.
    assertNoWorkspaceLinks(foremanDeploy);
    removeForemanBinDir(foremanDeploy);
    // Prove the hoisted deploy is physical before any stage copy: npm keeps
    // physical directories shipped inside a tarball, so the staged graph stays
    // complete for the E2E containment checks that follow.
    assertPhysicalForemanDependencies(foremanDeploy);

    const packedRuntime = pack(runtimeStage, outputDir);
    // Rename the npm-pack tarball to a target-qualified name so multi-target
    // release uploads never collide (the npm filename is host-ambiguous).
    const runtimeTgz = path.join(outputDir, `wrenyard-runtime-${version}-${target.triplet}.tgz`);
    fs.copyFileSync(packedRuntime, runtimeTgz);
    fs.rmSync(packedRuntime, { force: true });
    const cliStage = path.join(tmp, 'cli');
    writePackageStage(cliStage, version, versions, path.join(ROOT, 'apps', 'cli', 'dist', 'wrenyard.mjs'), runtimeStage, foremanDeploy);
    assertPortableTree(cliStage);
    assertNoBuildPathsInStagedForeman(cliStage, 'cli', tmp, ROOT);
    assertStagedForemanRuns(cliStage, 'cli', '.wrenyard/runtime');
    assertNoForemanBinDir(path.join(cliStage, 'services', 'foreman'), 'cli');
    const cliTgz = await packCliTgz(cliStage, outputDir, version);

    const suiteStage = path.join(tmp, 'suite');
    writeSuiteStage(suiteStage, version, sea, runtimeStage, foremanDeploy);
    assertPortableTree(suiteStage);
    assertNoBuildPathsInStagedForeman(suiteStage, 'suite', tmp, ROOT);
    assertStagedForemanRuns(suiteStage, 'suite', 'runtime');
    assertNoForemanBinDir(path.join(suiteStage, 'services', 'foreman'), 'suite');
    const suiteZip = path.join(outputDir, `wrenyard-${version}-${target.triplet}-suite.zip`);
    await zipDirectory(suiteStage, suiteZip);

    let desktopZip = null;
    if (!options.skipDesktop) {
      run('pnpm', ['--filter', '@wrenyard/desktop', 'dist:dir']);
      const built = newestElectronAppDir(path.join(ROOT, 'apps', 'desktop', 'release'));
      if (!built) throw new Error('Desktop build produced no unpacked application');
      desktopZip = path.join(outputDir, `wrenyard-desktop-${version}-${target.triplet}.zip`);
      await zipDirectory(built, desktopZip);
    }

    // Pet is a separate Electron desktop artifact. Build an unpacked app and
    // create the release zip ourselves so Linux, macOS and Windows all emit the
    // same target-qualified archive shape (electron-builder has no uniform zip
    // target across all three hosts).
    let petZip = null;
    run('pnpm', ['--filter', '@wrenyard/pet', 'run', 'build']);
    run('pnpm', ['--filter', '@wrenyard/pet', 'exec', 'electron-builder', '--dir', '--publish', 'never']);
    const builtPet = newestElectronAppDir(path.join(ROOT, 'apps', 'pet', 'release'));
    if (!builtPet) throw new Error('Pet build produced no unpacked application');
    petZip = path.join(outputDir, `wrenyard-pet-${version}-${target.triplet}.zip`);
    await zipDirectory(builtPet, petZip);

    copyFile(path.join(ROOT, 'scripts', 'install.sh'), path.join(outputDir, 'install.sh'), 0o755);
    copyFile(path.join(ROOT, 'scripts', 'install.ps1'), path.join(outputDir, 'install.ps1'));
    const licenseReport = path.join(outputDir, 'third-party-licenses.json');
    run(process.execPath, [path.join(RELEASE_DIR, 'generate-license-report.mjs'), '--output', licenseReport]);

    // The embedded development identity (release-manifest.json) travels with
    // the release as a separate, non-self-referential document: its
    // platform_artifacts stay empty and the actual shipped files are indexed
    // by the external target artifact index below.
    const devIdentity = path.join(outputDir, 'release-manifest.json');
    copyFile(path.join(ROOT, 'release-manifest.json'), devIdentity);

    const distributables = [sea, runtimeTgz, cliTgz, suiteZip, desktopZip, petZip, licenseReport, path.join(outputDir, 'install.sh'), path.join(outputDir, 'install.ps1'), devIdentity]
      .filter(Boolean)
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    const artifacts = distributables.map((file) => ({
      path: path.basename(file),
      size: fs.statSync(file).size,
      sha256: sha256(file),
    }));
    for (const artifact of artifacts) {
      fs.writeFileSync(path.join(outputDir, `${artifact.path}.sha256`), `${artifact.sha256}  ${artifact.path}\n`);
    }
    fs.writeFileSync(path.join(outputDir, 'SHA256SUMS'), `${artifacts.map((item) => `${item.sha256}  ${item.path}`).join('\n')}\n`);
    // Target-qualified external artifact index: names the host target and lists
    // every emitted artifact with size and digest. It deliberately excludes
    // itself so the index never becomes self-referential, and it labels the
    // build honestly (ad-hoc on macOS, unsigned elsewhere) since this pipeline
    // never holds signing secrets.
    const provenance =
      process.platform === 'darwin'
        ? 'ad-hoc'
        : process.platform === 'win32'
          ? 'unsigned'
          : 'unsigned';
    fs.writeFileSync(path.join(outputDir, `artifact-manifest-${target.triplet}.json`), `${JSON.stringify({
      schema: 'wrenyard.local-artifacts.v1',
      suite_version: version,
      target: target.triplet,
      publishable: false,
      signed: false,
      provenance,
      artifacts,
    }, null, 2)}\n`);

    console.log(`[release] built ${artifacts.length} artifacts for ${target.triplet} in ${outputDir}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[release] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
