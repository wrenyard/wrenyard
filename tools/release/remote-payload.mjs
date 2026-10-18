#!/usr/bin/env node
// Remote daemon bootstrap payload builder for WY Remote.
//
// It turns an already-staged per-target `resources/wrenyard` closure (bundled
// Node, `daemon/daemon.mjs`, the native better-sqlite3/sharp binaries and the
// DSH closure, exactly as `pack.mjs` stages them) into a minimal, versioned,
// checksummed per-user bootstrap payload for a remote host.
//
// Public remote install targets are `darwin-arm64`, `win32-x64` and `linux-x64`.
// Linux ARM64 and macOS x64 are explicit future work and are refused here rather
// than silently supported.
//
// This is NOT the historical suite/CLI installer: it produces a per-user
// payload that a remote bootstrap extracts under the user's home with no sudo
// and no system install. It never overwrites an incompatible live daemon, writes
// an atomic readiness marker only after a successful stage, and recovers from a
// failed staging attempt.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { entryFor } from './platform.mjs';
import { requirePlainVersion } from './release-context.mjs';

/** The public remote install targets. */
export const REMOTE_TARGETS = Object.freeze(['darwin-arm64', 'win32-x64', 'linux-x64']);

/** Resolve a target entry, refusing anything outside the first-version matrix. */
export function remoteTarget(triplet) {
  if (!REMOTE_TARGETS.includes(triplet)) {
    throw new Error(
      `${triplet} is not a public remote target; supported: ${REMOTE_TARGETS.join(', ')} `
      + '(Linux ARM64 and macOS x64 are future work)',
    );
  }
  return entryFor(triplet.split('-')[0], triplet.split('-')[1]);
}

/** Canonical payload file name for one version/target. */
export function remotePayloadName(version, triplet) {
  remoteTarget(triplet);
  return `wrenyard-remote-${version}-${triplet}.tar.gz`;
}

/** Metadata sidecar file name for one version/target. */
export function remoteMetadataName(version, triplet) {
  remoteTarget(triplet);
  return `wrenyard-remote-${version}-${triplet}.json`;
}

/** The per-user destination for a payload on a remote host, under the home dir. */
export function perUserPrefix(homeDir, version) {
  return path.join(homeDir, '.wrenyard', 'remote', version);
}

/** The atomic readiness marker path for a per-user prefix. */
export function readinessMarkerPath(prefix) {
  return path.join(prefix, 'READY');
}

function walkFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(path.relative(root, file).split(path.sep).join('/'));
    }
  };
  walk(root);
  return files;
}

// The closure every remote payload must contain. `daemon/daemon.mjs` is the
// daemon entry; the bundled Node is what runs it on the target.
function requiredClosureEntries(entry) {
  return [
    'contracts/versions.json',
    'SUITE_VERSION',
    `runtime/node${entry.exeSuffix}`,
    'daemon/daemon.mjs',
  ];
}

/**
 * Assert the staged closure carries this target's native binaries, not the build
 * host's. This is what makes the builder a real cross-platform source/target
 * step instead of a same-platform payload copy: a native module prebuild for
 * another platform-arch is refused, and a build-host compiled binary is refused
 * whenever the source and target differ.
 */
export function assertTargetNativeClosure(stageDir, entry, sourceTriplet) {
  const expected = `${entry.platform}-${entry.arch}`;
  // A cross-platform build (source triplet != target) may not carry native
  // binaries compiled on the build host, because those cannot run on the target.
  const crossBuild = typeof sourceTriplet === 'string' && sourceTriplet !== '' && sourceTriplet !== expected;
  const daemonModules = path.join(stageDir, 'daemon', 'node_modules');
  if (!fs.existsSync(daemonModules)) return;
  const natives = walkFiles(daemonModules).filter((rel) => rel.endsWith('.node'));
  for (const rel of natives) {
    const segments = rel.split('/');
    // A prebuild directory names its platform-arch; if this native does not sit
    // under a matching prebuild dir, it is a compiled `build/Release` binary
    // that only the build host can run.
    // A prebuild may be a directory (`darwin-arm64/`) or a file
    // (`darwin-arm64.node`), optionally with a libc suffix (`linux-x64-musl`).
    const named = segments
      .find((segment) => /^(darwin|linux|win32)-/.test(segment))
      ?.replace(/\.node$/, '');
    if (named && named !== expected && !named.startsWith(`${expected}-`)) {
      throw new Error(`native module ${rel} targets ${named}, expected ${expected}`);
    }
    if (!named && crossBuild && rel.includes('build/Release/')) {
      throw new Error(
        `native module ${rel} is a build-host binary and cannot be copied from ${sourceTriplet} to ${expected}`,
      );
    }
  }
}

/** Extract a `.tar.gz` with a fresh empty staging dir, failing closed on error. */
function archivePayload(stageDir, archivePath) {
  const result = spawnSync('tar', ['-czf', archivePath, '-C', stageDir, '.'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`tar failed (${result.status}): ${(result.stderr ?? '').slice(-2000)}`);
  }
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/**
 * Build one remote bootstrap payload from a target's staged closure and write it
 * (plus its checksum and metadata) into `outDir` atomically.
 *
 * @param {object} options
 * @param {string} options.stageDir   staged `resources/wrenyard` closure for the target
 * @param {string} options.version    plain x.y.z product version
 * @param {string} options.targetTriplet  the remote target (darwin-arm64|win32-x64|linux-x64)
 * @param {string} options.sourceTriplet  the build host triplet the stage came from
 * @param {string} options.outDir     directory to write the payload into
 * @returns {object} the matching-version distribution metadata
 */
export function buildRemotePayload(options) {
  const { stageDir, sourceTriplet, outDir } = options;
  const version = requirePlainVersion(options.version);
  const targetTriplet = options.targetTriplet;
  const entry = remoteTarget(targetTriplet);
  if (!fs.existsSync(stageDir) || !fs.statSync(stageDir).isDirectory()) {
    throw new Error(`remote payload stage does not exist: ${stageDir}`);
  }
  for (const rel of requiredClosureEntries(entry)) {
    if (!fs.existsSync(path.join(stageDir, rel))) {
      throw new Error(`remote payload stage is missing ${rel}`);
    }
  }
  assertTargetNativeClosure(stageDir, entry, sourceTriplet);
  fs.mkdirSync(outDir, { recursive: true });

  const name = remotePayloadName(version, targetTriplet);
  const finalArchive = path.join(outDir, name);
  const tempArchive = path.join(outDir, `.${name}.${process.pid}.tmp`);
  try {
    archivePayload(stageDir, tempArchive);
    fs.renameSync(tempArchive, finalArchive);
  } catch (error) {
    // Safe recovery of failed staging: remove the partial archive only.
    try { fs.rmSync(tempArchive, { force: true }); } catch { /* best effort */ }
    throw error;
  }

  const sha256 = sha256File(finalArchive);
  const bytes = fs.statSync(finalArchive).size;
  fs.writeFileSync(`${finalArchive}.sha256`, `${sha256}  ${name}\n`);

  const metadata = {
    name,
    version,
    target: targetTriplet,
    source: sourceTriplet,
    platform: entry.platform,
    arch: entry.arch,
    sha256,
    bytes,
    entrypoint: 'daemon/daemon.mjs',
    node: `runtime/node${entry.exeSuffix}`,
    createdAt: new Date().toISOString(),
    // Distribution contract: per-user install, no sudo, no system service, no
    // overwriting an incompatible live daemon; the readiness marker is written
    // only after a successful stage.
    perUser: true,
    sudo: false,
    readinessMarker: 'READY',
  };
  const metadataPath = path.join(outDir, remoteMetadataName(version, targetTriplet));
  const tempMetadata = `${metadataPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempMetadata, `${JSON.stringify(metadata, null, 2)}\n`);
  fs.renameSync(tempMetadata, metadataPath);
  return metadata;
}

/**
 * Refuse to replace a live remote daemon whose version is incompatible with the
 * payload being staged. Same-version and absent live daemons are allowed.
 */
export function assertCompatibleLiveDaemon(liveVersion, payloadVersion) {
  if (typeof liveVersion === 'string' && liveVersion && liveVersion !== payloadVersion) {
    throw new Error(
      `remote daemon ${liveVersion} is running and is not ${payloadVersion}; refusing to overwrite an incompatible daemon`,
    );
  }
}

/**
 * Write the atomic readiness marker that a bootstrap sets only after a payload
 * is fully staged. The marker is written to a temp file and renamed into place,
 * so a reader never observes a partially written marker.
 */
export function writeReadinessMarker(prefix, metadata) {
  fs.mkdirSync(prefix, { recursive: true });
  const marker = readinessMarkerPath(prefix);
  const temp = `${marker}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: metadata.version, target: metadata.target, sha256: metadata.sha256, at: new Date().toISOString() })}\n`);
  fs.renameSync(temp, marker);
  return marker;
}

function main() {
  const args = process.argv.slice(2);
  const arg = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const stageDir = arg('--stage');
  const version = arg('--version');
  const targetTriplet = arg('--target');
  const sourceTriplet = arg('--source') ?? `${process.platform}-${process.arch}`;
  const outDir = arg('--out') ?? path.join(process.cwd(), '.artifacts', 'remote');
  if (!stageDir || !version || !targetTriplet) {
    throw new Error('usage: remote-payload.mjs --stage <dir> --version <x.y.z> --target <triplet> [--source <triplet>] [--out <dir>]');
  }
  const metadata = buildRemotePayload({ stageDir, version, targetTriplet, sourceTriplet, outDir });
  console.log(`[remote-payload] ${metadata.name} ${metadata.sha256} (${metadata.bytes} bytes)`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`[remote-payload] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
