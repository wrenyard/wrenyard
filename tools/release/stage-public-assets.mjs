#!/usr/bin/env node

import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packageVersion, REPO_ROOT } from './release-context.mjs';
import { assertAssetNames, canonicalAssetNames } from './update-feed.mjs';

const TARGETS = ['darwin-arm64', 'win32-x64'];

export function stagePublicAssets({
  inputDir,
  outputDir,
  version = packageVersion(),
}) {
  mkdirSync(outputDir, { recursive: true });
  const existing = readdirSync(outputDir);
  if (existing.length !== 0) {
    throw new Error(`public asset output directory must be empty: ${outputDir}`);
  }

  const names = canonicalAssetNames(version);
  for (const name of names) {
    const target = TARGETS.find((candidate) => name.includes(`-${candidate}`));
    const source = resolve(inputDir, `wrenyard-release-${target}`, name);
    if (!statSync(source, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`missing public release archive: ${source}`);
    }
    copyFileSync(source, resolve(outputDir, basename(name)));
  }
  assertAssetNames(readdirSync(outputDir).sort(), version);
  return names;
}

function parseArgs(argv) {
  const options = {
    inputDir: resolve(REPO_ROOT, 'artifacts'),
    outputDir: resolve(REPO_ROOT, 'release-assets'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--input' || arg === '--output') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg === '--input' ? 'inputDir' : 'outputDir'] = resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const names = stagePublicAssets(parseArgs(process.argv.slice(2)));
    for (const name of names) process.stdout.write(`${name}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
