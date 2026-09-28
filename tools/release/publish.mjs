#!/usr/bin/env node
// Single publish entry point. It validates the tag, confirms the three canonical
// installers, publishes them as a prerelease, commits the update feed to the
// `updates` branch, then removes this run's transient workflow artifacts. Every
// external command goes through the injectable `run` seam so the fixture tests
// never touch a real remote.

import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packageVersion, REPO_ROOT, signingSummary, validateDevTag } from './release-context.mjs';
import { runCommand } from './run-command.mjs';
import { assertAssetNames, canonicalAssetNames, prepareMetadata } from './update-feed.mjs';

const MAX_FEED_ATTEMPTS = 5;

// Confirm the three canonical installers exist in the downloaded artifacts
// before anything is published. The map is built in memory and validated
// against the version-derived names, so a missing, extra or mislabeled asset
// fails closed.
export function confirmCanonicalAssets({ artifactsDir, version = packageVersion() }) {
  const found = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        if (found.has(entry.name)) throw new Error(`duplicate release asset: ${entry.name}`);
        found.set(entry.name, file);
      }
    }
  };
  walk(artifactsDir);
  return assertAssetNames([...found.keys()].sort(), version).map((name) => ({ name, path: found.get(name) }));
}

// Create a draft release, upload the three installers, then publish as
// prerelease. An existing release is refused outright and assets are never
// clobbered.
export function publishGitHubRelease({ assets, repository, tag, sha, version = packageVersion(), run = runCommand }) {
  validateDevTag(tag, version);
  if (!repository) throw new Error('repository is required');
  if (!sha) throw new Error('commit sha is required');
  const names = assertAssetNames(assets.map((asset) => basename(asset)), version);

  const existing = run('gh', ['release', 'view', tag, '-R', repository], { allowFailure: true });
  if (existing.status === 0) {
    throw new Error(`release ${tag} already exists; refusing to delete or overwrite it`);
  }

  const notes = [
    `Public Wrenyard ${version} development prerelease.`,
    `Built from commit ${sha}.`,
    `Signing status: ${signingSummary()}.`,
  ].join('\n');
  run('gh', ['release', 'create', tag, '-R', repository, '--title', `Wrenyard ${version}`, '--notes', notes, '--prerelease', '--draft']);
  for (const asset of assets) {
    run('gh', ['release', 'upload', tag, asset, '-R', repository]);
  }
  run('gh', ['release', 'edit', tag, '-R', repository, '--draft=false', '--prerelease']);
  return names;
}

function assertSafePublicationDir(publicationDir, workspace) {
  const target = resolve(publicationDir);
  const workspaceRoot = resolve(workspace);
  const isWithin = (parent, child) => {
    const pathFromParent = relative(parent, child);
    return pathFromParent === '' || (pathFromParent !== '..' && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent));
  };
  if (
    basename(target) !== 'updates-publication'
    || target === parse(target).root
    || dirname(target) === parse(target).root
    || isWithin(workspaceRoot, target)
    || isWithin(target, workspaceRoot)
  ) {
    throw new Error(`unsafe update-feed publication directory: ${target}`);
  }
  return target;
}

// Push the immutable version document and the channel head in one commit.
// Retries a rejected push without force, never rewrites a published version and
// never regresses the channel head.
export function publishUpdateFeed({
  assetsDir,
  publicationDir,
  repository,
  tag,
  workspace = REPO_ROOT,
  version = packageVersion(),
  run = runCommand,
}) {
  validateDevTag(tag, version);
  if (!repository) throw new Error('repository is required');

  publicationDir = assertSafePublicationDir(publicationDir, workspace);
  rmSync(publicationDir, { recursive: true, force: true });
  mkdirSync(publicationDir, { recursive: true });

  const remote = run('git', ['-C', workspace, 'remote', 'get-url', 'origin']).stdout.trim();
  if (!remote) throw new Error('origin has no remote URL');
  run('git', ['init', '-q', publicationDir]);
  run('git', ['remote', 'add', 'origin', remote], { cwd: publicationDir });
  // Reuse actions/checkout's credential configuration without putting its token
  // in this script, an argv value, a remote URL, or command output.
  run('git', ['config', 'include.path', resolve(workspace, '.git', 'config')], { cwd: publicationDir });
  run('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'], { cwd: publicationDir });
  run('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: publicationDir });

  const branch = run('git', ['ls-remote', '--exit-code', '--heads', 'origin', 'updates'], { cwd: publicationDir, allowFailure: true });
  if (branch.status === 0) {
    run('git', ['fetch', '--depth', '1', 'origin', 'updates'], { cwd: publicationDir });
    run('git', ['checkout', '-q', '-B', 'updates', 'FETCH_HEAD'], { cwd: publicationDir });
  } else if (branch.status === 2) {
    run('git', ['checkout', '-q', '--orphan', 'updates'], { cwd: publicationDir });
  } else {
    throw new Error(`could not query the updates branch (exit ${branch.status}); refusing to publish a feed`);
  }

  const publishedAt = run('gh', ['release', 'view', tag, '-R', repository, '--json', 'publishedAt', '--jq', '.publishedAt']).stdout.trim();
  if (!publishedAt) throw new Error(`release ${tag} has no publication timestamp; refusing to publish a feed`);

  for (let attempt = 1; attempt <= MAX_FEED_ATTEMPTS; attempt += 1) {
    const prepared = prepareMetadata({ assetsDir, version, repository, publishedAt, metadataDir: publicationDir });
    run('git', ['add', ...prepared.files.map((file) => relative(publicationDir, file).split(sep).join('/'))], { cwd: publicationDir });
    const diff = run('git', ['diff', '--cached', '--quiet'], { cwd: publicationDir, allowFailure: true });
    if (diff.status === 0) return { changed: false, attempts: attempt };
    if (diff.status !== 1) throw new Error(`git diff failed with exit ${diff.status}`);
    run('git', ['commit', '-q', '-m', `chore(updates): publish ${version} feed`], { cwd: publicationDir });
    const push = run('git', ['push', 'origin', 'HEAD:updates'], { cwd: publicationDir, allowFailure: true });
    if (push.status === 0) return { changed: true, attempts: attempt };
    run('git', ['fetch', '--depth', '1', 'origin', 'updates'], { cwd: publicationDir });
    run('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: publicationDir });
  }
  throw new Error('could not publish the update feed after repeated attempts');
}

export function cleanupRunArtifacts({ repository, runId, run = runCommand }) {
  if (!repository) throw new Error('repository is required');
  if (!/^\d+$/.test(String(runId ?? ''))) throw new Error(`invalid run id: ${runId}`);
  const response = run('gh', ['api', '--paginate', '--slurp', `repos/${repository}/actions/runs/${runId}/artifacts`]);
  const pages = JSON.parse(response.stdout);
  const ids = pages.flatMap((page) => page.artifacts ?? []).map((artifact) => artifact.id);
  for (const id of ids) {
    run('gh', ['api', '-X', 'DELETE', `repos/${repository}/actions/artifacts/${id}`]);
  }
  return ids;
}

export function publishRelease({
  artifactsDir,
  repository,
  tag,
  sha,
  version = packageVersion(),
  workspace = REPO_ROOT,
  publicationDir,
  stagingDir = resolve(REPO_ROOT, 'release-assets'),
  runId,
  run = runCommand,
}) {
  validateDevTag(tag, version);
  const confirmed = confirmCanonicalAssets({ artifactsDir, version });
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  for (const { name, path: source } of confirmed) copyFileSync(source, resolve(stagingDir, name));

  publishGitHubRelease({
    assets: canonicalAssetNames(version).map((name) => resolve(stagingDir, name)),
    repository,
    tag,
    sha,
    version,
    run,
  });
  publishUpdateFeed({ assetsDir: stagingDir, publicationDir, repository, tag, workspace, version, run });
  cleanupRunArtifacts({ repository, runId, run });
  return { version, assets: canonicalAssetNames(version) };
}

function main(argv) {
  const artifactsIndex = argv.indexOf('--artifacts');
  const publicationIndex = argv.indexOf('--publication-dir');
  const runnerTemp = process.env.RUNNER_TEMP;
  if (publicationIndex < 0 && !runnerTemp) throw new Error('RUNNER_TEMP or --publication-dir is required');
  const result = publishRelease({
    artifactsDir: artifactsIndex >= 0 && argv[artifactsIndex + 1] ? resolve(argv[artifactsIndex + 1]) : resolve(REPO_ROOT, 'artifacts'),
    publicationDir: publicationIndex >= 0 && argv[publicationIndex + 1] ? resolve(argv[publicationIndex + 1]) : resolve(runnerTemp, 'updates-publication'),
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.GITHUB_REF_NAME,
    sha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
  });
  process.stdout.write(`published ${result.version}: ${result.assets.join(', ')}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
