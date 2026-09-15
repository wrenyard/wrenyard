#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packageVersion, REPO_ROOT, signingSummary, validateDevTag } from './release-context.mjs';
import { runCommand } from './run-command.mjs';
import { assertAssetNames } from './update-feed.mjs';

export function publishGitHubRelease({
  assetsDir,
  repository,
  tag,
  sha,
  version = packageVersion(),
  run = runCommand,
}) {
  validateDevTag(tag, version);
  if (!repository) throw new Error('repository is required');
  if (!sha) throw new Error('commit sha is required');
  const names = assertAssetNames(
    readdirSync(assetsDir).filter((name) => name.endsWith('.zip')).sort(),
    version,
  );

  const existing = run('gh', ['release', 'view', tag, '-R', repository], { allowFailure: true });
  if (existing.status === 0) {
    throw new Error(`release ${tag} already exists; refusing to delete or overwrite it`);
  }

  const notes = [
    `Public Wrenyard ${version} development prerelease.`,
    `Built from commit ${sha}.`,
    `Signing status: ${signingSummary()}.`,
  ].join('\n');
  run('gh', [
    'release', 'create', tag,
    '-R', repository,
    '--title', `Wrenyard ${version}`,
    '--notes', notes,
    '--prerelease',
    '--draft',
  ]);
  for (const name of names) {
    run('gh', ['release', 'upload', tag, resolve(assetsDir, name), '-R', repository]);
  }
  run('gh', ['release', 'edit', tag, '-R', repository, '--draft=false', '--prerelease']);
  return names;
}

function main(argv) {
  const assetsIndex = argv.indexOf('--assets');
  const assetsDir = assetsIndex >= 0 && argv[assetsIndex + 1]
    ? resolve(argv[assetsIndex + 1])
    : resolve(REPO_ROOT, 'release-assets');
  publishGitHubRelease({
    assetsDir,
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.GITHUB_REF_NAME,
    sha: process.env.GITHUB_SHA,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
