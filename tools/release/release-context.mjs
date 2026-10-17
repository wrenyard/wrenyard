// Shared release context for the build and publish scripts: the only place that
// reads the root version, validates the plain release tag and native target, and
// reports the signing summary.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { entryFor } from './platform.mjs';

export const RELEASE_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(RELEASE_DIR, '..', '..');

// Releases are plain patches: exactly x.y.z with no prerelease, no build
// metadata and no leading zeros. The `-dev.N` prerelease scheme is retired, so
// a prerelease tag or a mismatched tag fails closed before any mutation.
const PLAIN_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function requirePlainVersion(version) {
  if (typeof version !== 'string' || !PLAIN_VERSION_PATTERN.test(version)) {
    throw new Error(`version ${version || '(empty)'} is not a plain x.y.z release version`);
  }
  return version;
}

export function packageVersion(root = REPO_ROOT) {
  const value = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  return requirePlainVersion(value);
}

export function validateReleaseTag(tag, version = packageVersion()) {
  requirePlainVersion(version);
  const expected = `v${version}`;
  if (tag !== expected) {
    throw new Error(`tag ${tag || '(empty)'} is not the plain release tag ${expected}`);
  }
  return expected;
}

// Tag pushes carry GITHUB_REF_TYPE=tag and GITHUB_REF_NAME=<tag>; manual
// workflow_dispatch builds carry neither and are build-only, so no tag is
// validated. The build and publish scripts share this rule.
export function releaseTagFromEnv(env = process.env) {
  return env.GITHUB_REF_TYPE === 'tag' ? env.GITHUB_REF_NAME : '';
}

export function validateNativeTarget(target, platform = process.platform, arch = process.arch) {
  const actual = entryFor(platform, arch).triplet;
  if (target !== actual) throw new Error(`expected build target ${target}, got ${actual}`);
  if (!['darwin-arm64', 'win32-x64', 'linux-x64'].includes(target)) {
    throw new Error(`target ${target} is not a maintained public release target`);
  }
  return actual;
}

export function signingSummary() {
  return 'macOS ad-hoc; Windows unsigned; Linux unsigned';
}
