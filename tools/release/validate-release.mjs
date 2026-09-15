#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packageVersion, validateDevTag, validateNativeTarget } from './release-context.mjs';
import { run as checkVersions } from '../version-sync.mjs';

export function validateReleaseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--tag' || arg === '--target') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.tag && !options.target) throw new Error('usage: validate-release.mjs [--tag TAG] [--target TARGET]');

  const version = packageVersion();
  if (options.tag) validateDevTag(options.tag, version);
  if (options.target) {
    validateNativeTarget(options.target);
    if (checkVersions(['--check']) !== 0) throw new Error('release component versions are out of sync');
  }
  return { version, ...options };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = validateReleaseArguments(process.argv.slice(2));
    process.stdout.write(`release context valid for ${result.version}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
