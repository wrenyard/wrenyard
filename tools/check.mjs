#!/usr/bin/env node
// Publish gate. `pnpm check` runs exactly the release-blocking checks:
// public identifiers, committed secrets, legal/provenance metadata, and the
// first-party version contract. Tests and type checking are not part of `check`.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const GATES = [
  ['public identifiers', join('tools', 'check-public-identifiers.mjs')],
  ['secrets', join('tools', 'check-secrets.mjs')],
  ['legal', join('tools', 'release', 'verify-legal.mjs')],
];

let failed = false;

for (const [name, script] of GATES) {
  const result = spawnSync(process.execPath, [join(root, script)], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    console.error(`check: ${name} failed to run: ${result.error.message}`);
    failed = true;
  } else if (result.status !== 0) {
    console.error(`check: ${name} failed (exit ${result.status ?? 'unknown'})`);
    failed = true;
  }
}

// Version consistency: the root package.json is the single source of truth and
// apps/desktop/package.json carries the only other copy.
try {
  const rootVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const desktopVersion = JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8')).version;
  if (typeof rootVersion !== 'string' || rootVersion === '') {
    console.error('check: version consistency failed: root package.json has no version');
    failed = true;
  } else if (rootVersion !== desktopVersion) {
    console.error(`check: version consistency failed: root ${rootVersion} != apps/desktop ${desktopVersion}`);
    failed = true;
  }
} catch (error) {
  console.error(`check: version consistency failed: ${error instanceof Error ? error.message : String(error)}`);
  failed = true;
}

if (failed) {
  console.error('check: FAIL');
  process.exit(1);
}
console.log('check: OK');
