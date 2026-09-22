#!/usr/bin/env node
/**
 * Thin source-development launcher.
 *
 * This file deliberately does almost nothing: it parses the few supported
 * flags, replaces an already-running source-development stack for this
 * checkout, and then runs `tools/dev/worker.mjs` in a child process. The
 * supervisor modules are only ever loaded inside that worker, so a whole-stack
 * restart (and every `pnpm dev` after the first) always runs the current
 * supervisor, its helpers, and everything they import transitively.
 *
 * `pnpm dev` is the only normal entry point. A second invocation for the same
 * checkout replaces the previous owned stack instead of reporting "already
 * running". Pressing Ctrl+C once stops the owned stack; in-flight tasks and
 * conversations may be interrupted.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EXIT, runLauncher } from './lib/launcher.mjs';
import { parseDevArgs } from './lib/release-desktop.mjs';

const checkout = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const parsed = parseDevArgs(process.argv.slice(2));

if (parsed.unknown.length > 0) {
  process.stderr.write(`Unknown argument: ${parsed.unknown[0]}\n`);
  process.exit(EXIT.failed);
}

if (typeof globalThis.fetch !== 'function') {
  // Node 24 always has fetch; this only documents the runtime expectation.
  process.stderr.write('Node 24.19 or newer is required. Run: pnpm install --frozen-lockfile\n');
  process.exit(EXIT.failed);
}

try {
  const result = await runLauncher({
    checkout,
    killDesktop: parsed.killDesktop,
    workerEntry: join(checkout, 'tools', 'dev', 'worker.mjs'),
    launcherEntry: join(checkout, 'tools', 'dev', 'run.mjs'),
    args: process.argv.slice(2),
    env: process.env,
  });
  process.exit(result.exitCode);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(EXIT.failed);
}
