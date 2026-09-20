#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSupervisor } from './lib/supervisor.mjs';
import { EXIT } from './lib/constants.mjs';
import { parseDevArgs } from './lib/release-desktop.mjs';

const checkout = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const parsed = parseDevArgs(process.argv.slice(2));
if (parsed.unknown.length > 0) {
  process.stderr.write(`Unknown argument: ${parsed.unknown[0]}\n`);
  process.exit(EXIT.failed);
}

const supervisor = createSupervisor({
  checkout,
  killDesktop: parsed.killDesktop,
  stdout: (line) => process.stdout.write(`${line}\n`),
  onStopped() {
    process.exit(EXIT.ok);
  },
});

const onSignal = () => {
  process.stdout.write('SIGINT received; requesting an orderly stop.\n');
  void supervisor.handleSignal();
};

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

try {
  const result = await supervisor.start();
  if (result.alreadyRunning) process.exit(EXIT.ok);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(EXIT.failed);
}
