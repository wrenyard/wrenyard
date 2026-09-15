#!/usr/bin/env node

import { rmSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packageVersion, REPO_ROOT, validateDevTag } from './release-context.mjs';
import { runCommand } from './run-command.mjs';
import { prepareMetadata } from './update-feed.mjs';

function requireSuccess(result, message) {
  if (result.status !== 0) throw new Error(message);
  return result;
}

function assertSafePublicationDir(publicationDir, workspace) {
  const target = resolve(publicationDir);
  const workspaceRoot = resolve(workspace);
  const isWithin = (parent, child) => {
    const pathFromParent = relative(parent, child);
    return pathFromParent === '' || (
      pathFromParent !== '..'
      && !pathFromParent.startsWith(`..${sep}`)
      && !isAbsolute(pathFromParent)
    );
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
  // Reuse actions/checkout's credential configuration without putting its
  // token in this script, an argv value, a remote URL, or command output.
  run('git', ['config', 'include.path', resolve(workspace, '.git', 'config')], { cwd: publicationDir });
  run('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'], { cwd: publicationDir });
  run('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: publicationDir });

  const branch = run(
    'git',
    ['ls-remote', '--exit-code', '--heads', 'origin', 'updates'],
    { cwd: publicationDir, allowFailure: true },
  );
  if (branch.status === 0) {
    run('git', ['fetch', '--depth', '1', 'origin', 'updates'], { cwd: publicationDir });
    run('git', ['checkout', '-q', '-B', 'updates', 'FETCH_HEAD'], { cwd: publicationDir });
  } else if (branch.status === 2) {
    run('git', ['checkout', '-q', '--orphan', 'updates'], { cwd: publicationDir });
  } else {
    throw new Error(`could not query the updates branch (exit ${branch.status}); refusing to publish a feed`);
  }

  const release = run('gh', [
    'release', 'view', tag,
    '-R', repository,
    '--json', 'publishedAt',
    '--jq', '.publishedAt',
  ]);
  const publishedAt = release.stdout.trim();
  if (!publishedAt) throw new Error(`release ${tag} has no publication timestamp; refusing to publish a feed`);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const prepared = prepareMetadata({
      assetsDir,
      version,
      repository,
      publishedAt,
      metadataDir: publicationDir,
    });
    const relativeFiles = prepared.files.map((file) => file.slice(publicationDir.length + 1));
    run('git', ['add', ...relativeFiles], { cwd: publicationDir });
    const diff = run('git', ['diff', '--cached', '--quiet'], {
      cwd: publicationDir,
      allowFailure: true,
    });
    if (diff.status === 0) return { changed: false, attempts: attempt };
    if (diff.status !== 1) {
      requireSuccess(diff, `git diff failed with exit ${diff.status}`);
    }
    run('git', ['commit', '-q', '-m', `chore(updates): publish ${version} feed`], { cwd: publicationDir });
    const push = run('git', ['push', 'origin', 'HEAD:updates'], {
      cwd: publicationDir,
      allowFailure: true,
    });
    if (push.status === 0) return { changed: true, attempts: attempt };
    run('git', ['fetch', '--depth', '1', 'origin', 'updates'], { cwd: publicationDir });
    run('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: publicationDir });
  }
  throw new Error('could not publish the update feed after repeated attempts');
}

function main(argv) {
  const assetsIndex = argv.indexOf('--assets');
  const publicationIndex = argv.indexOf('--publication-dir');
  const runnerTemp = process.env.RUNNER_TEMP;
  if (publicationIndex < 0 && !runnerTemp) throw new Error('RUNNER_TEMP or --publication-dir is required');
  publishUpdateFeed({
    assetsDir: assetsIndex >= 0 && argv[assetsIndex + 1]
      ? resolve(argv[assetsIndex + 1])
      : resolve(REPO_ROOT, 'release-assets'),
    publicationDir: publicationIndex >= 0 && argv[publicationIndex + 1]
      ? resolve(argv[publicationIndex + 1])
      : resolve(runnerTemp, 'updates-publication'),
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.GITHUB_REF_NAME,
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
