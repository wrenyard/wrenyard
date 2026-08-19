#!/usr/bin/env node
/**
 * @wrenyard/desktop — dev installer (macOS only).
 *
 * 1. Builds the unpacked Electron app (`npm run dist:dir` in apps/desktop),
 *    or installs from an existing artifact when `--artifact` is given.
 * 2. Requires exactly one `.app` bundle in the release output.
 * 3. Stages the bundle on the home volume and verifies its code signature.
 * 4. Atomically replaces `~/Applications/Wrenyard Desktop.app`, keeping the
 *    previous bundle for rollback if the swap fails.
 * 5. Registers the installed app with LaunchServices, unregisters the
 *    unpacked build leftover, and deletes it so Spotlight only lists
 *    `~/Applications/Wrenyard Desktop.app`.
 *
 * The installer is explicit that unsupported platforms must use the official
 * build artifacts instead.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const APP_NAME = 'Wrenyard Desktop.app';
const SOURCE_DIR = resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');
const RELEASE_DIR = join(SOURCE_DIR, 'release');
const DEST_DIR = join(homedir(), 'Applications');
const DEST_APP = join(DEST_DIR, APP_NAME);

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

function fail(message) {
  console.error(`[install-dev] ${message}`);
  process.exit(1);
}

// Progress goes to stderr so stdout stays machine-readable under --json.
function log(message) {
  console.error(`[install-dev] ${message}`);
}

function usage() {
  console.error(`Usage: node tools/desktop/install-dev.mjs [--artifact PATH] [--json]

Options:
  --artifact PATH  Install an existing .app bundle or .zip instead of building
  --json           Print a machine-readable JSON result on stdout
  -h, --help       Show this help
`);
}

if (platform() !== 'darwin') {
  fail(`unsupported platform "${platform()}": this installer is macOS-only; use the official build artifacts elsewhere`);
}

function parseArgs(argv) {
  const options = { artifact: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--artifact') {
      const value = argv[index + 1];
      if (!value) fail('--artifact requires a path');
      options.artifact = resolve(value);
      index += 1;
    } else if (arg.startsWith('--artifact=')) {
      options.artifact = resolve(arg.slice('--artifact='.length));
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function hideFromSpotlight(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.metadata_never_index'), '');
}

/** Drop LaunchServices + the unpacked .app so Spotlight does not list a second Desktop. */
function unregisterAndRemoveReleaseApp(appPath) {
  const resolved = resolve(appPath);
  const releaseRoot = resolve(RELEASE_DIR);
  if (resolved === resolve(DEST_APP) || !resolved.startsWith(`${releaseRoot}/`)) return;
  if (existsSync(LSREGISTER)) {
    spawnSync(LSREGISTER, ['-u', resolved], { stdio: 'ignore' });
  }
  log(`removing Spotlight-visible build leftover ${resolved}…`);
  rmSync(resolved, { recursive: true, force: true });
  hideFromSpotlight(dirname(resolved));
  hideFromSpotlight(releaseRoot);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
  return result;
}

function findAppBundle(dir) {
  if (!existsSync(dir)) {
    fail(`release dir missing: ${dir} (run the desktop build first)`);
  }
  const apps = [];
  const visit = (currentDir, depth) => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(currentDir, entry.name);
      if (entry.name.endsWith('.app')) {
        apps.push(candidate);
      } else if (depth < 2) {
        visit(candidate, depth + 1);
      }
    }
  };
  visit(dir, 0);
  if (apps.length !== 1) {
    fail(`expected exactly one .app bundle in ${dir}, found ${apps.length}`);
  }
  return apps[0];
}

/**
 * Resolve the source .app bundle. Returns the bundle path plus an optional
 * temporary extraction directory that the caller must clean up.
 */
function resolveSourceArtifact(artifact) {
  if (!existsSync(artifact)) {
    fail(`artifact not found: ${artifact}`);
  }
  if (artifact.endsWith('.app')) {
    return { app: artifact, cleanup: null };
  }
  if (!artifact.endsWith('.zip')) {
    fail(`unsupported artifact type (expected .app or .zip): ${artifact}`);
  }
  const extractDir = mkdtempSync(join(homedir(), '.wrenyard-extract-'));
  run('ditto', ['-x', '-k', artifact, extractDir]);
  return { app: findAppBundle(extractDir), cleanup: extractDir };
}

function readBundleVersion(appPath) {
  const plistPath = join(appPath, 'Contents', 'Info.plist');
  try {
    const raw = readFileSync(plistPath, 'utf8');
    const match = raw.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    if (match) return match[1];
  } catch {
    // fall through to package.json
  }
  try {
    const pkg = JSON.parse(readFileSync(join(SOURCE_DIR, 'package.json'), 'utf8'));
    return String(pkg.version ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

const options = parseArgs(process.argv.slice(2));

// Stage on the home volume so the final rename into ~/Applications is atomic
// (renameSync cannot cross devices).
const stagingRoot = mkdtempSync(join(homedir(), '.wrenyard-install-'));
const stagedApp = join(stagingRoot, APP_NAME);
const backupApp = join(stagingRoot, `previous-${APP_NAME}`);
let artifactExtractDir = null;

try {
  let builtApp;
  if (options.artifact) {
    const resolved = resolveSourceArtifact(options.artifact);
    builtApp = resolved.app;
    artifactExtractDir = resolved.cleanup;
    log(`using artifact ${options.artifact} -> ${builtApp}`);
  } else {
    log('building unpacked Electron app (npm run dist:dir)…');
    run('npm', ['run', 'dist:dir'], { cwd: SOURCE_DIR });
    builtApp = findAppBundle(RELEASE_DIR);
  }

  log(`staging ${builtApp}…`);
  mkdirSync(stagingRoot, { recursive: true });
  run('ditto', [builtApp, stagedApp]);

  log('verifying code signature…');
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', stagedApp]);

  if (!existsSync(DEST_DIR)) {
    log(`creating ${DEST_DIR}…`);
    run('mkdir', ['-p', DEST_DIR]);
  }

  const hadPrevious = existsSync(DEST_APP);
  if (hadPrevious) {
    log(`backing up existing ${DEST_APP}…`);
    renameSync(DEST_APP, backupApp);
  }

  try {
    log(`atomically installing ${DEST_APP}…`);
    renameSync(stagedApp, DEST_APP);
  } catch (error) {
    if (hadPrevious) {
      log('install failed; restoring previous app…');
      renameSync(backupApp, DEST_APP);
    }
    throw error;
  }

  if (hadPrevious) {
    log('removing previous app backup…');
    rmSync(backupApp, { recursive: true, force: true });
  }

  if (existsSync(LSREGISTER)) {
    log('registering with LaunchServices…');
    run(LSREGISTER, ['-f', DEST_APP]);
  } else {
    log('lsregister not found; skipping LaunchServices registration');
  }

  unregisterAndRemoveReleaseApp(builtApp);

  const version = readBundleVersion(DEST_APP);
  const result = { path: DEST_APP, version, previous: hadPrevious };
  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    log(`installed Wrenyard Desktop v${version} at ${DEST_APP}`);
    console.log(`Wrenyard Desktop ${version}\n${DEST_APP}`);
  }
} finally {
  if (artifactExtractDir) rmSync(artifactExtractDir, { recursive: true, force: true });
  rmSync(stagingRoot, { recursive: true, force: true });
}
