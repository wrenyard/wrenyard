#!/usr/bin/env node

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// The source CLI (`pnpm wrenyard`) runs the TypeScript entry through tsx.
const cliSource = join(here, '..', 'apps', 'cli', 'src', 'index.mts');

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
