const { execFileSync, spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { homedir, tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function normalizeArchivePath(value) {
  return value.replaceAll('\\', '/').replace(/^\/+/, '');
}

function packagedPathCategory(value) {
  const normalized = normalizeArchivePath(value);
  if (/\.map$/iu.test(normalized)) return 'source_maps';
  if (/\.d\.(?:ts|mts|cts)$/iu.test(normalized)) return 'declarations';
  if (normalized.startsWith('dist/types/')) return 'first_party_types';
  return null;
}

/** Release development-artifact gate. Errors contain aggregate categories only,
 * never package paths or file contents. */
function assertNoForbiddenPackagedEntries(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const category = packagedPathCategory(entry);
    if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  if (counts.size > 0) {
    const summary = [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, count]) => `${category}=${count}`)
      .join(', ');
    throw new Error(`Desktop package contains forbidden development artifacts (${summary})`);
  }
}

function localPathNeedles() {
  return [...new Set([homedir(), tmpdir(), ROOT]
    .filter((value) => typeof value === 'string' && value.length >= 4)
    .flatMap((value) => [value, value.replaceAll('\\', '/')]))];
}

function containsLocalPath(buffer, needles) {
  return needles.some((needle) => buffer.includes(Buffer.from(needle)));
}

function asarApi() {
  const requireFromBuilder = createRequire(require.resolve('electron-builder'));
  return requireFromBuilder('@electron/asar');
}

function resourcesPath(context) {
  if (context.electronPlatformName === 'darwin') {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
    );
  }
  return path.join(context.appOutDir, 'resources');
}

function packagedExecutablePath(context) {
  const productFilename = context.packager.appInfo.productFilename;
  if (context.electronPlatformName === 'darwin') {
    return path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
  }
  const executableName = context.packager.platformSpecificBuildOptions.executableName ?? productFilename;
  return path.join(context.appOutDir, context.electronPlatformName === 'win32'
    ? `${executableName}.exe`
    : executableName);
}

function redactSmokeOutput(value, roots) {
  let redacted = value;
  for (const root of roots) {
    if (root) redacted = redacted.replaceAll(root, '[packaged-path]');
  }
  return redacted.slice(-4_096);
}

function waitForDshReady(child, roots, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let probing = false;
    let stdout = '';
    let stderr = '';
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error(
        `Packaged DSH startup smoke timed out. stderr: ${redactSmokeOutput(stderr || '(none)', roots)}`,
      ));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-16_384);
      if (probing) return;
      const match = /^dsh web:\s*(http:\/\/127\.0\.0\.1:\d+)\s*$/mu.exec(stdout);
      if (!match) return;
      probing = true;
      const controller = new AbortController();
      const fetchTimer = setTimeout(() => controller.abort(), 5_000);
      fetch(match[1], { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          finish();
        })
        .catch((error) => finish(new Error(
          `Packaged DSH startup smoke was not reachable: ${error instanceof Error ? error.message : String(error)}`,
        )))
        .finally(() => clearTimeout(fetchTimer));
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-16_384);
    });
    child.on('error', (error) => finish(error));
    child.on('exit', (code, signal) => {
      finish(new Error(
        `Packaged DSH exited before ready (code=${code}, signal=${signal}). stderr: ${redactSmokeOutput(stderr || '(none)', roots)}`,
      ));
    });
  });
}

function signalChildTree(child, signal) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } catch {
      // The process tree is already gone.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process tree is already gone.
    }
  }
}

async function stopChildTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalChildTree(child, 'SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    signalChildTree(child, 'SIGKILL');
  }
}

function credentialFreeEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/(?:token|secret|pass(?:word)?|credential|auth|cookie|session|key|apple[_-]?id)/iu.test(name)) {
      delete env[name];
    }
  }
  env.HTTP_PROXY = 'http://127.0.0.1:9';
  env.HTTPS_PROXY = 'http://127.0.0.1:9';
  env.ALL_PROXY = 'http://127.0.0.1:9';
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  return env;
}

function hostElectronPlatform() {
  return process.platform === 'win32' ? 'win32' : process.platform;
}

function assertCrossTargetDshImports(runtimeModules, dshBin, smokeHome, roots) {
  const env = {
    ...credentialFreeEnv(),
    DSH_HOME: smokeHome,
    DSH_TELEMETRY_MODE: 'DISABLED',
  };
  const probes = [
    ['-e', `require(${JSON.stringify(path.join(runtimeModules, 'yaml'))})`],
    ['--expose-internals', dshBin, 'web', '--dump-default-config'],
  ];
  for (const args of probes) {
    try {
      execFileSync(process.execPath, args, {
        cwd: smokeHome,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : String(error);
      throw new Error(
        `Packaged DSH cross-target import smoke failed. stderr: ${redactSmokeOutput(stderr, roots)}`,
      );
    }
  }
}

/** Boot the actual packaged DSH web runtime under Electron-as-Node. This catches
 * missing transitive runtime files in app.asar(.unpacked) before an artifact is
 * signed or installed. The isolated smoke profile contains no credentials. */
async function assertPackagedDshStarts(context) {
  const resources = resourcesPath(context);
  const runtimeModules = path.join(resources, 'app.asar.unpacked', 'node_modules');
  const dshBin = path.join(runtimeModules, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const smokeHome = mkdtempSync(path.join(tmpdir(), 'wrenyard-dsh-pack-smoke-'));
  let child;
  try {
    const profileDir = path.join(smokeHome, 'profiles', 'web');
    const profileModules = path.join(profileDir, 'node_modules');
    mkdirSync(profileModules, { recursive: true });
    symlinkSync(
      path.join(runtimeModules, '@deepseek-ai'),
      path.join(profileModules, '@deepseek-ai'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify({
      name: '@wrenyard/packaged-dsh-smoke',
      private: true,
      type: 'module',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2)}\n`);

    const roots = [context.appOutDir, smokeHome, homedir(), ROOT];
    if (context.electronPlatformName !== hostElectronPlatform()) {
      assertCrossTargetDshImports(runtimeModules, dshBin, smokeHome, roots);
      return;
    }

    const executable = packagedExecutablePath(context);
    child = spawn(executable, [
      '--expose-internals',
      dshBin,
      '--profile', 'web',
      '--no-open',
      '--host', '127.0.0.1',
      '--port', '0',
    ], {
      cwd: smokeHome,
      env: {
        ...credentialFreeEnv(),
        DSH_HOME: smokeHome,
        DSH_TELEMETRY_MODE: 'DISABLED',
        ELECTRON_RUN_AS_NODE: '1',
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    await waitForDshReady(child, roots);
  } finally {
    if (child) await stopChildTree(child);
    rmSync(smokeHome, { recursive: true, force: true });
  }
}

async function assertSafeDesktopPackage(context) {
  const archivePath = path.join(resourcesPath(context), 'app.asar');
  const { extractFile, listPackage, statFile } = asarApi();
  const entries = listPackage(archivePath);
  assertNoForbiddenPackagedEntries(entries);

  const { scanText } = await import(pathToFileURL(path.join(ROOT, 'tools', 'check-secrets.mjs')).href);
  const needles = localPathNeedles();
  let localPathFindingCount = 0;
  let secretFindingCount = 0;
  for (const entry of entries) {
    const normalized = normalizeArchivePath(entry);
    const stat = statFile(archivePath, normalized);
    if (stat.files) continue;
    const content = extractFile(archivePath, normalized);
    if (containsLocalPath(content, needles)) localPathFindingCount += 1;
    // Provider-token detectors are intentionally limited to first-party Desktop
    // output. Dependency examples are excluded by policy and dependency runtime
    // bytes otherwise create unactionable lexical false positives.
    if (normalized.startsWith('dist/') && !content.includes(0)) {
      secretFindingCount += scanText(content.toString('utf8')).length;
    }
  }
  if (localPathFindingCount > 0 || secretFindingCount > 0) {
    throw new Error(
      `Desktop package failed sensitive-content gate (local_paths=${localPathFindingCount}, first_party_secret_signatures=${secretFindingCount})`,
    );
  }
}

/**
 * Give preview macOS bundles a complete ad-hoc signature before zip creation.
 * electron-builder may subsequently replace it with a trusted CSC identity;
 * no credentials or identities are read or printed by this hook.
 */
exports.default = async function afterPack(context) {
  await assertSafeDesktopPackage(context);
  await assertPackagedDshStarts(context);
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--verbose', appPath], {
    stdio: 'inherit',
  });
  // Documents/Github is Spotlight-indexed. An unpacked .app under
  // apps/desktop/release/ otherwise appears beside ~/Applications.
  for (const dir of [context.appOutDir, path.dirname(context.appOutDir)]) {
    writeFileSync(path.join(dir, '.metadata_never_index'), '');
  }
};

exports.assertNoForbiddenPackagedEntries = assertNoForbiddenPackagedEntries;
exports.assertPackagedDshStarts = assertPackagedDshStarts;
exports.containsLocalPath = containsLocalPath;
exports.localPathNeedles = localPathNeedles;
exports.packagedPathCategory = packagedPathCategory;
