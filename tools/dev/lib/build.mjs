import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { electronDesktopInvocation, pnpmInvocation } from './spawn.mjs';
import { COMPONENTS } from './watch.mjs';

const BUILD_TIMEOUT_MS = 900_000;
const TYPECHECK_TIMEOUT_MS = 300_000;
const KILL_GRACE_MS = 2_000;
const ALL_TARGETS = ['renderer', 'main', 'preload', 'pet'];
const SHARED_ARGS = ['-r', '--filter', './packages/*', '--filter', './packages/features/*', '--filter', './packages/clients/*', '--if-present', 'run', 'build'];

function buildError(message, output = '') {
  return Object.assign(new Error(message), { output });
}

/** Node >= 24.19, an installed node_modules, a pinned lockfile and a resolvable Electron binary. */
export function checkToolchain({ checkout }) {
  const errors = [];
  const [major, minor] = process.versions.node.split('.').map((part) => Number(part));
  if (major < 24 || (major === 24 && minor < 19)) errors.push(`Node ${process.versions.node} is too old; Wrenyard requires Node >= 24.19.`);
  if (!existsSync(join(checkout, 'node_modules'))) errors.push('node_modules is missing from this checkout.');
  if (!existsSync(join(checkout, 'pnpm-lock.yaml'))) errors.push('pnpm-lock.yaml is missing from this checkout.');
  try { electronDesktopInvocation(checkout); } catch { errors.push('Electron executable was not found.'); }
  return errors;
}

export function desktopTargetsFor(components) {
  if (components.has(COMPONENTS.shared)) return [...ALL_TARGETS];
  const targets = [];
  if (components.has(COMPONENTS.desktopRenderer)) targets.push('renderer');
  if (components.has(COMPONENTS.desktopMain)) targets.push('main', 'pet');
  if (components.has(COMPONENTS.desktopPreload)) targets.push('preload');
  return [...new Set(targets)];
}

/**
 * Spawn with shell:false and capture output. A timeout or abort always settles
 * the promise and escalates SIGTERM to SIGKILL, even if the child ignores the
 * first signal or exits 0 after the deadline.
 */
function run(command, args, { cwd, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(buildError('build cancelled')); return; }
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let output = '';
    let outcome = null;
    let killTimer = null;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    const kill = (name) => { try { child.kill(name); } catch { /* already gone */ } };
    const stop = (reason) => {
      outcome = outcome ?? reason;
      kill('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    timer.unref?.();
    const onAbort = () => stop('abort');
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    child.on('error', (error) => { cleanup(); reject(buildError(error.message, output)); });
    child.on('close', (status) => {
      cleanup();
      if (outcome === 'timeout') reject(buildError(`command timed out after ${timeoutMs}ms`, output));
      else if (outcome === 'abort') reject(buildError('build cancelled', output));
      else resolve({ status: status ?? 1, output });
    });
  });
}

/** Shared packages and the Desktop targets a component set needs. */
export async function build({ checkout, components, signal }) {
  if (components.has(COMPONENTS.shared)) {
    const pnpm = pnpmInvocation(checkout, SHARED_ARGS);
    const result = await run(pnpm.command, pnpm.args, { cwd: checkout, timeoutMs: BUILD_TIMEOUT_MS, signal });
    if (result.status !== 0) throw buildError('shared package build failed', result.output);
  }
  const targets = desktopTargetsFor(components);
  if (targets.length > 0) {
    const args = [join('apps', 'desktop', 'tools', 'build.mjs'), '--no-clean', `--only=${targets.join(',')}`];
    const result = await run(process.execPath, args, { cwd: checkout, timeoutMs: BUILD_TIMEOUT_MS, signal });
    if (result.status !== 0) throw buildError('desktop build failed', result.output);
  }
}

/** The daemon's production TypeScript, resolved through the daemon package. */
export async function typecheckDaemon({ checkout, signal }) {
  let tsc;
  try {
    tsc = createRequire(join(checkout, 'apps', 'daemon', 'package.json')).resolve('typescript/bin/tsc');
  } catch {
    throw buildError('typescript was not found for the daemon typecheck');
  }
  const result = await run(process.execPath, [tsc, '-p', 'apps/daemon/tsconfig.startup.json'], { cwd: checkout, timeoutMs: TYPECHECK_TIMEOUT_MS, signal });
  if (result.status !== 0) {
    const head = String(result.output ?? '').split('\n').slice(0, 40).join('\n');
    throw buildError(`daemon typecheck failed\n${head}`, result.output);
  }
}
