#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EXIT } from './lib/constants.mjs';
import { connectControl } from './lib/control.mjs';
import { processAlive } from './lib/identity.mjs';
import { readInstanceFile } from './lib/instance.mjs';
import { controlEndpoint, instancePath, sameCheckout, stateRoot, normalizeCheckout } from './lib/paths.mjs';
import { ERRORS } from './lib/protocol.mjs';
import { leftoverControlDecision } from './lib/leftover.mjs';
import { withDaemon } from './lib/rpc.mjs';
import { businessIpcPath } from './lib/paths.mjs';

const command = process.argv[2];
if (command !== 'restart' && command !== 'stop') {
  process.stderr.write('Usage: node tools/dev/client.mjs <restart|stop>\n');
  process.exit(EXIT.failed);
}

const checkout = normalizeCheckout(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const state = stateRoot(process.env, homedir());
const endpoint = controlEndpoint(process.platform, state);
const record = readInstanceFile(instancePath(state));

function fail(message, code = EXIT.failed) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

try {
  const client = await connectControl(endpoint);
  const status = await client.request('status', {});
  if (!sameCheckout(status.checkout, checkout)) {
    client.close();
    fail(`This command must run from the owning checkout:\n  ${status.checkout}\nCurrent checkout:\n  ${checkout}`, EXIT.failed);
  }
  const result = await client.request(command, {}, 180_000);
  process.stdout.write(`${command} ok\n${JSON.stringify(result, null, 2)}\n`);
  client.close();
  process.exit(EXIT.ok);
} catch (error) {
  const unreachable = /timed out|ECONNREFUSED|ENOENT|control endpoint|closed/iu.test(error instanceof Error ? error.message : String(error));
  if (!unreachable) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (command === 'restart' || !record || !sameCheckout(record.checkout, checkout)) {
    const decision = leftoverControlDecision({
      command,
      record,
      checkout,
      platform: process.platform,
      healthUnreachable: true,
    });
    if (decision.exit === EXIT.ok) {
      process.stdout.write(`${decision.message}\n`);
      process.exit(EXIT.ok);
    }
    fail(decision.message, decision.exit);
  }

  const ipcPath = businessIpcPath(process.platform, process.env);
  try {
    const health = await withDaemon(ipcPath, (client) => client.request('health.ping', {}), 1500);
    const decision = leftoverControlDecision({
      command: 'stop',
      record,
      checkout,
      platform: process.platform,
      health,
      healthUnreachable: false,
      supervisorAlive: processAlive(record.supervisorPid),
    });
    if (decision.action === 'shutdown-source') {
      await withDaemon(ipcPath, (client) => client.request('daemon.shutdown', { reason: 'source development leftover stop' }), 2000);
    }
    if (decision.exit === EXIT.ok) {
      process.stdout.write(`${decision.message}\n`);
      process.exit(EXIT.ok);
    }
    fail(decision.message, decision.exit);
  } catch {
    const decision = leftoverControlDecision({
      command: 'stop',
      record,
      checkout,
      platform: process.platform,
      healthUnreachable: true,
      supervisorAlive: processAlive(record.supervisorPid),
      daemonAlive: processAlive(record.daemonPid),
      desktopAlive: processAlive(record.desktopPid),
    });
    if (decision.exit === EXIT.ok) {
      process.stdout.write(`${decision.message}\n`);
      process.exit(EXIT.ok);
    }
    fail(decision.message, decision.exit);
  }
}

void ERRORS;
