#!/usr/bin/env node

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// Internal packages export TypeScript source, so the CLI always runs from
// source through tsx. A previously built `apps/cli/dist/wrenyard.mjs` must never
// take priority, or source edits would stop taking effect after one build.
const cliSource = join(here, '..', 'apps', 'cli', 'src', 'index.ts');

const result = spawnSync(
  process.execPath,
  [require.resolve('tsx/cli'), cliSource, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    env: process.env,
  },
);

if (result.error) {
  console.error(`wrenyard: failed to spawn launcher: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
