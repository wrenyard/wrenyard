const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { homedir, tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const { writeFileSync } = require('node:fs');
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

function pathNeedles(values) {
  return [...new Set(values
    .filter((value) => typeof value === 'string' && value.length >= 4)
    .flatMap((value) => {
      const variants = [value, value.replaceAll('\\', '/'), value.replaceAll('/', '\\')];
      for (const spelling of [value, value.replaceAll('\\', '/'), value.replaceAll('/', '\\')]) {
        for (const backslash of [spelling, spelling.replaceAll('\\', '\\\\')]) {
          variants.push(JSON.stringify(backslash).slice(1, -1));
        }
      }
      return variants;
    }))];
}

/** Exact source-checkout/CI workspace roots. These are actionable leaks in any
 * archive member, including dependency binaries. Callers may inject roots. */
function buildRootNeedles(exactRoots = [ROOT]) {
  return pathNeedles(exactRoots);
}

/** Generic per-user home/temp roots are only actionable in first-party output;
 * public dependency binaries legitimately embed upstream CI home paths. */
function genericHomeNeedles() {
  return pathNeedles([homedir(), tmpdir()]);
}

function containsLocalPath(buffer, needles) {
  return needles.some((needle) => buffer.includes(Buffer.from(needle)));
}

/** node_modules members are third-party unless vendor-scoped to @wrenyard,
 * mirroring isDependencyPath in tools/release/build-local-release.mjs. */
function isFirstPartyArchivePath(archivePath) {
  const segments = normalizeArchivePath(archivePath).split('/').filter(Boolean);
  const lastModulesIndex = segments.lastIndexOf('node_modules');
  if (lastModulesIndex === -1) return true;
  return segments[lastModulesIndex + 1] === '@wrenyard';
}

/** Production local-path decision, exported so regression tests exercise the
 * same branch used by assertSafeDesktopPackage. Exact checkout/output roots leak
 * from any member; generic home/temp roots are only actionable in first-party
 * output. */
function containsUnsafePackagedPath(archivePath, content, exactNeedles, genericNeedles) {
  return containsLocalPath(content, exactNeedles)
    || (isFirstPartyArchivePath(archivePath) && containsLocalPath(content, genericNeedles));
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

async function assertSafeDesktopPackage(context) {
  const archivePath = path.join(resourcesPath(context), 'app.asar');
  const { extractFile, listPackage, statFile } = asarApi();
  const entries = listPackage(archivePath);
  assertNoForbiddenPackagedEntries(entries);

  const { scanText } = await import(pathToFileURL(path.join(ROOT, 'tools', 'check-secrets.mjs')).href);
  const exactNeedles = buildRootNeedles([ROOT, context.appOutDir]);
  const genericNeedles = genericHomeNeedles();
  let localPathFindingCount = 0;
  let secretFindingCount = 0;
  for (const entry of entries) {
    const normalized = normalizeArchivePath(entry);
    // @electron/asar's native member lookup resolves paths with path.sep, so
    // forward-slash members fail for scoped packages on Windows. Native calls
    // use the platform spelling; all policy checks keep the slash spelling.
    const nativePath = path.normalize(normalized);
    const stat = statFile(archivePath, nativePath);
    if (stat.files) continue;
    const content = extractFile(archivePath, nativePath);
    if (containsUnsafePackagedPath(normalized, content, exactNeedles, genericNeedles)) {
      localPathFindingCount += 1;
    }
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
exports.assertSafeDesktopPackage = assertSafeDesktopPackage;
exports.buildRootNeedles = buildRootNeedles;
exports.containsLocalPath = containsLocalPath;
exports.containsUnsafePackagedPath = containsUnsafePackagedPath;
exports.genericHomeNeedles = genericHomeNeedles;
exports.isFirstPartyArchivePath = isFirstPartyArchivePath;
exports.packagedPathCategory = packagedPathCategory;
