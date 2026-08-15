#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const bundle = join(here, '..', 'apps', 'cli', 'dist', 'wrenyard.mjs');
const cliSource = join(here, '..', 'apps', 'cli', 'src', 'index.ts');

const launcherArgs = existsSync(bundle)
  ? [bundle]
  : [require.resolve('tsx/cli'), cliSource];

const result = spawnSync(process.execPath, [...launcherArgs, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: false,
  env: process.env,
});

if (result.error) {
  console.error(`wrenyard: failed to spawn launcher: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
