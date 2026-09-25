#!/usr/bin/env node
// `pnpm dev` entry point. There are no flags: any argument is rejected, and the
// whole run is owned by `runDev()` in the single-process supervisor.
import { runDev } from './lib/supervisor.mjs';

const args = process.argv.slice(2);
if (args.length > 0) {
  process.stderr.write(`Unknown argument: ${args[0]}\n`);
  process.exit(1);
}

try {
  process.exit(await runDev());
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
