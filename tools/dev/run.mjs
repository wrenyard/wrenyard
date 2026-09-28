#!/usr/bin/env node
// `pnpm dev:desktop` / `pnpm dev:daemon` entry point. The whole run is owned by
// `runDev()` in the single-process supervisor. `--daemon-only` supervises only
// the daemon and ignores Desktop source changes; every other argument is rejected.

// Internal packages export TypeScript source (the shared control client), so the
// supervisor's transitive imports are TypeScript. Register the installed tsx ESM
// loader before importing it instead of duplicating any protocol code. Node can
// strip erasable TypeScript itself, so a missing tsx loader is not fatal.
try {
  const { register } = await import('tsx/esm/api');
  register();
} catch { /* Node's own type stripping handles the erasable imports */ }

const { runDev } = await import('./lib/supervisor.mjs');

const args = process.argv.slice(2);
let daemonOnly = false;
for (const arg of args) {
  if (arg === '--daemon-only') {
    daemonOnly = true;
    continue;
  }
  process.stderr.write(`Unknown argument: ${arg}\n`);
  process.exit(1);
}

try {
  process.exit(await runDev({ daemonOnly }));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
