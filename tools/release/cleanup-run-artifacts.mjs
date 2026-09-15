#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCommand } from './run-command.mjs';

export function cleanupRunArtifacts({ repository, runId, run = runCommand }) {
  if (!repository) throw new Error('repository is required');
  if (!/^\d+$/.test(String(runId ?? ''))) throw new Error(`invalid run id: ${runId}`);
  const response = run('gh', [
    'api', '--paginate', '--slurp',
    `repos/${repository}/actions/runs/${runId}/artifacts`,
  ]);
  const pages = JSON.parse(response.stdout);
  const ids = pages.flatMap((page) => page.artifacts ?? []).map((artifact) => artifact.id);
  for (const id of ids) {
    run('gh', ['api', '-X', 'DELETE', `repos/${repository}/actions/artifacts/${id}`]);
  }
  return ids;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const ids = cleanupRunArtifacts({
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
    });
    process.stdout.write(`deleted ${ids.length} transient workflow artifact(s)\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
