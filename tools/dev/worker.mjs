#!/usr/bin/env node
/**
 * Source-development worker.
 *
 * `pnpm dev` (tools/dev/run.mjs) is a thin launcher; this is the process that
 * actually loads `lib/supervisor.mjs` and the modules it imports. Loading them
 * in a brand-new process is what makes a whole-stack restart run current code:
 * re-importing a module with a cache-busting query string cannot refresh its
 * transitive imports.
 *
 * The supervisor is constructed, then started on the next macrotask so the exit
 * handshake with the launcher is already wired even if startup fails fast.
 *
 * Two bounded protocols connect this process to its launcher:
 * - the launcher asks for a stop over IPC (a console-less child cannot receive
 *   SIGINT on Windows), and this process performs the orderly stop;
 * - an edit to the dev tooling itself exits with the reserved reload code, and
 *   the launcher starts a *fresh* worker so the new modules are loaded.
 *
 * Fatal admission/ownership errors stay terminal: they are reported and exit
 * non-zero. A failed first build does not: the supervisor keeps watching.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EXIT, WORKER_IPC } from './lib/launcher.mjs';
import { createSupervisor } from './lib/supervisor.mjs';
import { parseDevArgs } from './lib/release-desktop.mjs';

const checkout = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const parsed = parseDevArgs(process.argv.slice(2));

if (parsed.unknown.length > 0) {
  process.stderr.write(`Unknown argument: ${parsed.unknown[0]}\n`);
  process.exit(EXIT.failed);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(EXIT.failed);
}

/** Set once the worker is stopping so a reload request cannot race the exit. */
let exiting = false;

function exitAfterStop(code) {
  if (exiting) return;
  exiting = true;
  process.exit(code);
}

const supervisor = createSupervisor({
  checkout,
  killDesktop: parsed.killDesktop,
  stdout: (line) => process.stdout.write(`${line}\n`),
  onStopped() {
    exitAfterStop(EXIT.ok);
  },
  /**
   * Dev tooling changed. The supervisor has already stopped its owned stack, so
   * the only safe way to load the new modules is a fresh process: exit with the
   * reserved reload code and let the launcher restart the worker.
   */
  onReload() {
    process.stdout.write('Dev tooling changed; exiting for a fresh worker.\n');
    exitAfterStop(EXIT.reload);
  },
});

let stopping = false;

async function stopFromParent() {
  if (stopping) return;
  stopping = true;
  try {
    await supervisor.handleSignal();
    process.send?.({ type: WORKER_IPC.stopped });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.send?.({ type: WORKER_IPC.stopFailed });
  }
}

process.on('message', (message) => {
  if (message?.type === WORKER_IPC.stop) void stopFromParent();
});

// Keep a direct signal working for a hand-spawned worker (pnpm dev always uses
// the IPC path, since a console-less child may never see SIGINT on Windows).
const onSignal = () => {
  process.stdout.write('Stop signal received; requesting an orderly stop.\n');
  void supervisor.handleSignal();
};

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

setImmediate(() => {
  supervisor.start()
    .then((result) => {
      // A degraded first start (initial build or component failure) is not
      // fatal: the supervisor keeps watching and the next save retries.
      if (result?.degraded) {
        process.stdout.write('Source development started in a degraded state; fix the error and save to retry.\n');
      }
    })
    .catch((error) => {
      fail(error instanceof Error ? error.message : String(error));
    });
});
