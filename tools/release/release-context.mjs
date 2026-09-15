import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { entryFor } from './platform.mjs';
import { isSemver } from './update-feed.mjs';

export const RELEASE_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(RELEASE_DIR, '..', '..');

export function packageVersion(root = REPO_ROOT) {
  const value = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  if (!isSemver(value)) throw new Error(`root package has an invalid version: ${value}`);
  return value;
}

export function validateDevTag(tag, version = packageVersion()) {
  const expected = `v${version}`;
  if (!version.includes('-dev.') || tag !== expected) {
    throw new Error(`tag ${tag || '(empty)'} is not the explicit development tag ${expected}`);
  }
  return expected;
}

export function validateNativeTarget(target, platform = process.platform, arch = process.arch) {
  const actual = entryFor(platform, arch).triplet;
  if (target !== actual) throw new Error(`expected build target ${target}, got ${actual}`);
  if (!['darwin-arm64', 'win32-x64'].includes(target)) {
    throw new Error(`target ${target} is not a maintained public release target`);
  }
  return actual;
}

export function signingSummary() {
  return 'macOS ad-hoc; Windows unsigned';
}
