#!/usr/bin/env node
// Canonical local/CI release pipeline. It builds only the current host target,
// never publishes, and writes a CLI tarball (one public wrenyard launcher, with
// the daemon control tree and the bundled Node runtime hidden), a Node SEA
// executable, portable suite zip, optional Desktop zip (with its in-tree Pet
// module), the embedded development identity, legal report, checksums and a
// target-qualified artifact manifest to one output directory.

import archiver from 'archiver';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { entryFor } from './platform.mjs';
import { scanText } from '../check-secrets.mjs';

const RELEASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(RELEASE_DIR, '..', '..');
const target = entryFor();

// The shipped control tree is the deployed CLI package: the CLI owns the
// command implementation and pulls the daemon package (and tsx) in as physical
// production dependencies. Canonical source paths mirror to the stage as
// `apps/cli/**`; the daemon server entry inside it is
// `apps/cli/node_modules/@wrenyard/daemon/bin/daemon.mts`.
const STAGED_CONTROL_ROOT = 'apps/cli';
const STAGED_CLI_SOURCE = path.join('apps', 'cli', 'src', 'index.ts');

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

// Absolute workspace member directories (root plus the apps/* and packages/*
// and packages/features/* and packages/clients/* projects) used to prove the
// install state still covers the full dev set after the deploy.
function workspacePackageDirs(root) {
  const dirs = [root];
  for (const rel of ['apps', 'packages', 'packages/features', 'packages/clients']) {
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

// Source directories copied into the isolated deploy workspace. The deployed
// CLI package pulls the daemon and the workspace feature/client packages in as
// production dependencies, so every workspace member it can reach must be
// present for `pnpm deploy` to resolve them. These are physical directory
// listings only: the deploy itself follows the real package dependency graph,
// so DSH runtime packages and the @wrenyard/dsh-shell bundle reach the control
// tree through `@wrenyard/session` instead of any hand-copied asset step.
const DEPLOY_WORKSPACE_SOURCES = [
  path.join('apps', 'cli'),
  path.join('apps', 'daemon'),
  path.join('packages', 'models'),
  path.join('packages', 'providers'),
  path.join('packages', 'protocol'),
  path.join('packages', 'clients'),
  path.join('packages', 'execution'),
  path.join('packages', 'control-client'),
  path.join('packages', 'dsh-shell'),
  path.join('packages', 'features', 'auto-routing'),
  path.join('packages', 'features', 'gateway'),
  path.join('packages', 'features', 'quota'),
  path.join('packages', 'features', 'exec'),
  path.join('packages', 'features', 'provider'),
  path.join('packages', 'features', 'browser-use'),
  path.join('packages', 'features', 'computer-use'),
  path.join('packages', 'features', 'session'),
];

// Every first-party workspace package name that pnpm deploy may reference. A
// deployed manifest must never keep a workspace/file: spec for one of these:
// the physical snapshot beside it is the shipped dependency.
const WORKSPACE_PACKAGE_NAMES = [
  '@wrenyard/agent-client',
  '@wrenyard/auto-routing',
  '@wrenyard/browser-use',
  '@wrenyard/cli',
  '@wrenyard/client-claude',
  '@wrenyard/client-codebuddy',
  '@wrenyard/client-codex',
  '@wrenyard/client-cursor',
  '@wrenyard/client-dsh',
  '@wrenyard/client-grok',
  '@wrenyard/client-opencode',
  '@wrenyard/clients',
  '@wrenyard/computer-use',
  '@wrenyard/control-client',
  '@wrenyard/daemon',
  '@wrenyard/dsh-shell',
  '@wrenyard/exec',
  '@wrenyard/execution',
  '@wrenyard/gateway',
  '@wrenyard/models',
  '@wrenyard/protocol',
  '@wrenyard/provider-service',
  '@wrenyard/providers',
  '@wrenyard/quota',
  '@wrenyard/session',
];

// Third-party dependency scopes that must ship as physical directories in the
// deployed control tree. @deepseek-ai carries the DSH runtime the daemon-side
// session feature drives; it is asserted exactly like the first-party tree so a
// silent hoist/linker change cannot ship a control tree without its DSH runtime.
const ASSERTED_DEPENDENCY_SCOPES = ['@wrenyard/', '@deepseek-ai/'];

// Named non-scoped production dependencies of the control tree that are also
// asserted physical. Kept as an explicit list rather than "every third-party
// package" so the check stays a bounded, reviewable contract.
const ASSERTED_DEPENDENCY_NAMES = ['tsx', 'ajv', 'yaml', 'zod', 'better-sqlite3', '@langchain/core'];

// Reject only workspace symlinks: a packaged runtime must never point back into
// the source checkout or the pnpm store.
function assertNoWorkspaceLinks(root) {
  const violations = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const rel = path.relative(root, file);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      if (rel.includes('@wrenyard')) {
        violations.push(`workspace self-link staged: ${rel} -> ${fs.readlinkSync(file)}`);
      }
    }
  };
  walk(root);
  if (violations.length > 0) {
    throw new Error(`deployed control tree contains @wrenyard workspace entries:\n${violations.join('\n')}`);
  }
}

// A modern isolated pnpm deploy writes package-manager metadata at the deploy
// root and inside node_modules. Local workspace snapshots make those files
// contain build-host paths, but the physical runtime dependency tree does not
// need them. Remove only these known metadata files and fail closed if any
// survives.
function stripDeployMetadata(deploy) {
  for (const name of [
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'node_modules/.modules.yaml',
    'node_modules/.pnpm/lock.yaml',
    'node_modules/.pnpm-workspace-state-v1.json',
  ]) {
    const file = path.join(deploy, name);
    fs.rmSync(file, { force: true });
    if (fs.existsSync(file)) {
      throw new Error(`deployed control tree still contains ${name}: ${file}`);
    }
  }
}

// pnpm deploy rewrites workspace dependencies to absolute file: URLs rooted in
// its temporary workspace. The deployed tree already contains physical package
// snapshots, so normalize only those known internal dependency specs to their
// exact packaged versions before portability checks and staging.
function normalizeWorkspaceDependencySpecs(deploy) {
  const versions = new Map();
  const manifests = [path.join(deploy, 'package.json')];
  for (const name of WORKSPACE_PACKAGE_NAMES) {
    const manifestPath = path.join(deploy, 'node_modules', ...name.split('/'), 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    versions.set(name, manifest.version);
    manifests.push(manifestPath);
  }
  for (const manifestPath of manifests) {
    const manifest = readJson(manifestPath);
    let changed = false;
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = manifest[field];
      if (!dependencies) continue;
      for (const [name, version] of versions) {
        if (!(name in dependencies) || dependencies[name] === version) continue;
        dependencies[name] = version;
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
}

// Before the deployed tree is copied into any stage, every declared production
// dependency of the control tree (the deploy root plus each hoisted first-party
// package, restricted to ASSERTED_DEPENDENCY_SCOPES/NAMES) must exist as a
// physical directory, never a symlink. npm retains physical directories shipped
// inside a tarball's node_modules but prunes symlinked virtual-store entries, so
// the --config.node-linker=hoisted deploy plus this check guarantees the shipped
// dependency graph stays complete — including the DSH runtime the session
// feature drives; the E2E repeats physical-directory containment checks after
// extraction and after npm install.
function assertPhysicalDeployDependencies(deploy) {
  const manifests = [path.join(deploy, 'package.json')];
  for (const name of WORKSPACE_PACKAGE_NAMES) {
    const manifestPath = path.join(deploy, 'node_modules', ...name.split('/'), 'package.json');
    if (fs.existsSync(manifestPath)) manifests.push(manifestPath);
  }
  const direct = new Set();
  for (const manifestPath of manifests) {
    const manifest = readJson(manifestPath);
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        const scoped = ASSERTED_DEPENDENCY_SCOPES.some((scope) => name.startsWith(scope));
        if (!scoped && !ASSERTED_DEPENDENCY_NAMES.includes(name)) continue;
        direct.add(name);
      }
    }
  }
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
    throw new Error(`deployed control direct dependencies are not physical directories:\n${violations.join('\n')}`);
  }
}

// The deploy root is the CLI package itself: pnpm's isolated deploy writes the
// package and its production node_modules directly at <deploy>/node_modules.
// The deployed tree must never ship pnpm's .bin shim directory: every shipped
// launcher invokes tsx through an explicit path, and the .bin dir is what
// historically rewrote relative links into absolute build-temp paths. Modern
// pnpm layouts also nest shims at deeper depths (for example
// .pnpm/<pkg>/node_modules/.bin), so the removal walks the whole deploy tree.
function removeDeployBinDir(deploy) {
  removeNestedBinDirs(deploy);
  assertNoDeployBinDir(deploy, 'deploy');
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

// Fail closed if any directory named `.bin` remains anywhere in the deployed
// control tree, not only the top-level node_modules/.bin.
function assertNoDeployBinDir(deployRoot, label) {
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
  walk(deployRoot);
  if (violations.length > 0) {
    throw new Error(`${label} control tree still contains pnpm .bin shims:\n${violations.join('\n')}`);
  }
}

// Fail closed if any regular file inside a staged control runtime embeds the
// canonical release build temp path or the source worktree as byte strings.
// The scan complements the symlink containment checks: even without .bin
// shims, an absolute build path written into file content would break the
// packed artifacts on another machine.
function assertNoBuildPathsInStagedControl(stage, label, buildTmp, worktree) {
  const root = path.join(stage, STAGED_CONTROL_ROOT);
  if (!fs.existsSync(root)) {
    throw new Error(`staged ${label} control tree missing: ${root}`);
  }
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
          throw new Error(`staged ${label} control file embeds a build path: ${file}`);
        }
      }
    }
  };
  walk(root);
}

// Run the real staged control sources through the staged Node runtime and tsx
// to prove the artifact-contained control tree actually executes before it is
// emitted. nodeRelPath locates the staged bundled node (the CLI package hides
// it under .wrenyard/runtime while the suite keeps it at runtime/).
function assertStagedControlRuns(stage, label, nodeRelPath) {
  const node = path.join(stage, nodeRelPath, `node${target.exeSuffix}`);
  const tsx = path.join(stage, STAGED_CONTROL_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const source = path.join(stage, STAGED_CLI_SOURCE);
  for (const [name, file] of [['node', node], ['tsx', tsx], ['cli source', source]]) {
    if (!fs.existsSync(file)) throw new Error(`staged ${label} control entry missing ${name}: ${file}`);
  }
  const output = run(node, [tsx, source, '--version']);
  if (!output || !output.trim()) throw new Error(`staged ${label} control entry printed no --version output`);
}

// Resolve the pinned Node runtime binary from the root `node` dependency
// (declared pinned at node@24.19.0) instead of process.execPath, so every
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
  process.exitCode = main(process.argv.slice(2), {
  suiteRoot,
  nodeExecutable: path.join(suiteRoot, '.wrenyard', 'runtime', ${JSON.stringify(`node${target.exeSuffix}`)}),
  suiteVersion: ${JSON.stringify(version)},
  componentVersions: ${JSON.stringify(versions)},
});
`;
}

// Bounded staged-payload security gate. Runs on the actual first-party staged
// CLI and suite trees immediately before archive creation so a contaminated
// payload can never be hashed or published on either Windows or macOS. It
// rejects private-key/token signatures in first-party text, local developer
// machine/home/checkout absolute paths written into payload bytes, and pays
// special attention to forbidden user credential/config/database/log files.
// The exact release temp dir and source worktree are rejected everywhere; the
// generic developer-home values are rejected only in first-party files, because
// an upstream dependency can publicly ship bytes compiled under the same CI
// home (e.g. the upstream fsevents.node build) without being a local leak.
// Third-party dependency assets are not automatically secrets: upstream source
// maps and public documentation/certificate examples under node_modules are
// normal runtime assets, so only first-party source maps and the explicit
// credential/database/log artifacts are rejected. The bounded credential scan
// covers all first-party text but only real private-key material in
// dependencies. It never reads or prints matched secret values: observations
// name only the path and detector/rule.

const FORBIDDEN_PAYLOAD_NAMES = new Set([
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.netrc', '.pgpass',
  '.git-credentials', '.htpasswd',
]);

// Real secret containers are always rejected, whoever shipped them. Third-party
// public certificates and documentation are runtime assets, not credentials, so
// they are intentionally absent from this set.
const FORBIDDEN_PAYLOAD_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk', '.asc',
  '.db', '.sqlite', '.sqlite3', '.log',
]);

const FORBIDDEN_PAYLOAD_DIRS = new Set(['.git', '.gnupg', '.ssh', 'agent-workspace']);

// Upstream code legitimately spells PEM banners as format constants (jose's
// PKCS#8 prefix check in dist/webapi/key/import.js is the shipped example), so a
// dependency fails the credential scan only on real key material: a complete
// BEGIN/END private-key block, never a lone banner string.
const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u;

// A path is a dependency tree (third-party) when its last node_modules segment
// is not a @wrenyard scoped package; anything else under node_modules is an
// upstream asset. Segments come from splitting a relative path on the host
// separator, so the same tree classifies identically on Windows and POSIX.
function isDependencyPath(segments) {
  const index = segments.lastIndexOf('node_modules');
  return index >= 0 && segments[index + 1] !== '@wrenyard';
}

// Byte variants of one path candidate: raw, slash-normalized, backslash and
// JSON-escaped backslash spellings, so the same logical path is caught however
// it was serialized by the build host.
function pathByteVariants(candidate) {
  const values = new Set();
  for (const raw of [candidate, path.resolve(candidate)]) {
    values.add(raw);
    values.add(raw.replaceAll('\\', '/'));
    values.add(raw.replaceAll('/', '\\'));
    values.add(raw.replaceAll('\\', '\\\\'));
    values.add(raw.replaceAll('/', '\\\\'));
  }
  return [...values].filter(value => value.length > 3).map(value => Buffer.from(value));
}

// Exact build paths (the release temp dir and the source worktree) are never
// legitimate payload content, so they are rejected in ALL files. The generic
// developer-home values (os.homedir/HOME/USERPROFILE) are only distinct because
// a third-party dependency's publicly compiled bytes can legitimately embed the
// public CI build home (e.g. an upstream fsevents.node build),
// so those are enforced against first-party files only.
function buildPathNeedles(buildTmp, worktree) {
  const values = new Set();
  for (const candidate of [buildTmp, worktree]) {
    if (!candidate) continue;
    for (const bytes of pathByteVariants(candidate)) values.add(bytes);
  }
  return [...values];
}

function homePathNeedles() {
  const values = new Set();
  for (const candidate of [os.homedir(), process.env.HOME, process.env.USERPROFILE]) {
    if (!candidate) continue;
    for (const bytes of pathByteVariants(candidate)) values.add(bytes);
  }
  return [...values];
}

export function assertSafeReleasePayload(stage, label, buildTmp, worktree) {
  const root = path.resolve(stage);
  const buildNeedles = buildPathNeedles(buildTmp, worktree);
  const homeNeedles = homePathNeedles();
  const violations = [];
  const report = (file, rule) => violations.push(path.relative(root, file) + ': ' + rule);
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const segments = path.relative(root, file).split(path.sep);
      if (entry.isSymbolicLink()) continue;
      if (segments.some(segment => FORBIDDEN_PAYLOAD_DIRS.has(segment))) {
        report(file, 'forbidden private/workspace payload directory'); continue;
      }
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      const ext = path.extname(lower);
      const dependency = isDependencyPath(segments);
      if (FORBIDDEN_PAYLOAD_NAMES.has(lower)) {
        report(file, 'forbidden user credential/config file'); continue;
      }
      const bytes = fs.readFileSync(file);
      const text = bytes.includes(0) ? null : bytes.toString('utf8');
      const publicCertificate = dependency && ext === '.pem' && text
        && /^\s*-----BEGIN CERTIFICATE-----[\s\S]*-----END CERTIFICATE-----\s*$/.test(text)
        && !text.includes('PRIVATE KEY');
      if (FORBIDDEN_PAYLOAD_EXTENSIONS.has(ext) && !publicCertificate) {
        report(file, 'forbidden credential/secret/database/log file'); continue;
      }
      if (ext === '.map' && !dependency) report(file, 'source map payload forbidden');
      const embedsBuildPath = buildNeedles.some(needle => bytes.includes(needle));
      const embedsHomePath = !dependency && homeNeedles.some(needle => bytes.includes(needle));
      if (embedsBuildPath || embedsHomePath) report(file, 'embeds a local developer/home/checkout absolute path');
      if (!text) continue;
      // First-party code is scanned for every secret signature. Upstream assets
      // can contain public examples, but must never contain real key material.
      const findings = scanText(text).filter((finding) => {
        if (!dependency) return true;
        return finding.detector === 'pem-private-key' && PRIVATE_KEY_BLOCK.test(text);
      });
      if (findings.length) report(file, 'secret signature detected (' + [...new Set(findings.map(f => f.detector))].join(', ') + ')');
    }
  }
  walk(root);
  if (violations.length) throw new Error('unsafe staged ' + label + ' payload:\n' + violations.join('\n'));
}

// The npm package exposes exactly one public launcher (wrenyard); the control
// tree and the bundled Node runtime are hidden under .wrenyard so they never
// surface as extra public bin commands.
function writePackageStage(stage, version, versions, cliDist, controlDeploy) {
  ensureDir(path.join(stage, 'bin'));
  ensureDir(path.join(stage, 'dist'));
  ensureDir(path.join(stage, '.wrenyard', 'runtime'));
  fs.writeFileSync(path.join(stage, 'bin', 'wrenyard.mjs'), cliLauncher(version, versions));
  fs.chmodSync(path.join(stage, 'bin', 'wrenyard.mjs'), 0o755);
  copyFile(cliDist, path.join(stage, 'dist', 'wrenyard.mjs'));
  copyFile(pinnedNodeBinary(), path.join(stage, '.wrenyard', 'runtime', `node${target.exeSuffix}`), 0o755);
  copyDir(controlDeploy, path.join(stage, STAGED_CONTROL_ROOT));
  copyDir(path.join(ROOT, 'contracts'), path.join(stage, 'contracts'));
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'release-manifest.json', 'pnpm-workspace.yaml']) {
    copyFile(path.join(ROOT, name), path.join(stage, name));
  }
  const manifest = {
    name: '@wrenyard/cli',
    version,
    description: 'Wrenyard unified CLI.',
    type: 'module',
    license: 'MIT',
    os: [process.platform],
    cpu: [process.arch],
    bin: { wrenyard: './bin/wrenyard.mjs' },
    files: ['bin', 'dist', '.wrenyard', 'apps', 'contracts', 'release-manifest.json', 'pnpm-workspace.yaml', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'],
    engines: { node: '>=24.19.0' },
  };
  fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeSuiteStage(stage, version, sea, controlDeploy) {
  const seaName = `wrenyard${target.exeSuffix}`;
  copyFile(sea, path.join(stage, seaName), 0o755);
  copyFile(pinnedNodeBinary(), path.join(stage, 'runtime', `node${target.exeSuffix}`), 0o755);
  copyDir(controlDeploy, path.join(stage, STAGED_CONTROL_ROOT));
  copyDir(path.join(ROOT, 'contracts'), path.join(stage, 'contracts'));
  copyDir(path.join(ROOT, 'docs', 'release'), path.join(stage, 'docs', 'release'));
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'release-manifest.json', 'pnpm-workspace.yaml']) {
    copyFile(path.join(ROOT, name), path.join(stage, name));
  }
  copyFile(path.join(ROOT, 'scripts', 'install.sh'), path.join(stage, 'install.sh'), 0o755);
  copyFile(path.join(ROOT, 'scripts', 'install.ps1'), path.join(stage, 'install.ps1'));
  fs.writeFileSync(path.join(stage, 'SUITE_VERSION'), `${version}\n`);
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
          // Open each input only when the archive queue consumes it.
          archive.file(abs, { name: entryPath(abs), mode: stat.mode & 0o7777 });
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
    run('pnpm', ['--filter', '@wrenyard/cli', 'build']);

    const sea = path.join(outputDir, `wrenyard-${version}-${target.triplet}${target.exeSuffix}`);
    run(process.execPath, [
      path.join(RELEASE_DIR, 'build-sea.mjs'),
      '--cli', path.join(ROOT, 'apps', 'cli', 'dist', 'wrenyard-sea.cjs'),
      '--output', sea,
    ]);

    const controlDeploy = path.join(tmp, 'control');
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
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      copyFile(path.join(ROOT, name), path.join(deployWorkspace, name));
    }
    for (const rel of DEPLOY_WORKSPACE_SOURCES) {
      const source = path.join(ROOT, rel);
      if (!fs.existsSync(source)) {
        throw new Error(`deploy workspace source missing: ${rel}`);
      }
      copyDirWithoutNodeModules(source, path.join(deployWorkspace, rel));
    }
    run('pnpm', [
      '--config.node-linker=hoisted',
      '--config.package-import-method=copy',
      '--filter', '@wrenyard/cli',
      'deploy', '--prod', controlDeploy,
    ], { cwd: deployWorkspace });
    normalizeWorkspaceDependencySpecs(controlDeploy);
    // Strip deploy-only pnpm metadata before any CLI/suite copy. The embedded
    // control tree is a portable runtime tree, while the intentional
    // product-root pnpm-workspace.yaml is copied into each stage separately.
    stripDeployMetadata(controlDeploy);
    assertWorkspaceInstallStateUnchanged(ROOT, installSnapshot);
    assertPortableTree(controlDeploy);
    // Workspace packages are expected as physical snapshots; reject workspace
    // symlinks that would make the staged runtime depend on the source tree.
    assertNoWorkspaceLinks(controlDeploy);
    removeDeployBinDir(controlDeploy);
    // Prove the hoisted deploy is physical before any stage copy: npm keeps
    // physical directories shipped inside a tarball, so the staged graph stays
    // complete for the E2E containment checks that follow.
    assertPhysicalDeployDependencies(controlDeploy);

    const cliStage = path.join(tmp, 'cli');
    writePackageStage(cliStage, version, versions, path.join(ROOT, 'apps', 'cli', 'dist', 'wrenyard.mjs'), controlDeploy);
    assertPortableTree(cliStage);
    assertNoBuildPathsInStagedControl(cliStage, 'cli', tmp, ROOT);
    assertStagedControlRuns(cliStage, 'cli', '.wrenyard/runtime');
    assertNoDeployBinDir(path.join(cliStage, STAGED_CONTROL_ROOT), 'cli');
    assertSafeReleasePayload(cliStage, 'cli', tmp, ROOT);
    const cliTgz = await packCliTgz(cliStage, outputDir, version);

    const suiteStage = path.join(tmp, 'suite');
    writeSuiteStage(suiteStage, version, sea, controlDeploy);
    assertPortableTree(suiteStage);
    assertNoBuildPathsInStagedControl(suiteStage, 'suite', tmp, ROOT);
    assertStagedControlRuns(suiteStage, 'suite', 'runtime');
    assertNoDeployBinDir(path.join(suiteStage, STAGED_CONTROL_ROOT), 'suite');
    assertSafeReleasePayload(suiteStage, 'suite', tmp, ROOT);
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

    const distributables = [sea, cliTgz, suiteZip, desktopZip, licenseReport, path.join(outputDir, 'install.sh'), path.join(outputDir, 'install.ps1'), devIdentity]
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

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(`[release] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
