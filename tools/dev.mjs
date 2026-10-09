#!/usr/bin/env node
// Root dev launcher for `pnpm dev`.
//
// Runs the existing parallel daemon + desktop `dev` scripts against an
// isolated, cwd-relative `.wrenyard/` runtime root, so a source checkout never
// touches the real user config/state/workspace and every worktree gets its own
// dev control socket.
//
// Dependency-free Node ESM (`node tools/dev.mjs`). It intentionally does not
// import `@wrenyard/control` (that package exposes TypeScript sources that
// native Node cannot load); the short IPC base-dir logic below mirrors
// `defaultWrenyardIpcPath`.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const log = (text) => process.stdout.write(`[dev] ${text}\n`);

// 1) Runtime root: always anchored to the directory where `pnpm dev` was
//    launched (never the script path, the shared Git directory, or the main
//    checkout). Persistent: created only when missing, never reset or deleted.
const runtimeRoot = resolve(process.cwd(), '.wrenyard');
const configRoot = join(runtimeRoot, 'config');
const stateRoot = join(runtimeRoot, 'state');
const workspaceRoot = join(runtimeRoot, 'workspace');
for (const dir of [configRoot, stateRoot, workspaceRoot]) mkdirSync(dir, { recursive: true });

// 3) Per-worktree dev IPC: hash the canonical full startup-worktree path
//    (case-folded on win32) into a short hex identity. The Unix socket lives
//    under the canonical short temp base, never under the deep .wrenyard tree.
function shortIpcBaseDir() {
  if (process.platform === 'win32') return undefined;
  try { return realpathSync('/tmp'); } catch { return realpathSync(tmpdir()); }
}

function resolveDevIpcPath() {
  const canonical = realpathSync(process.cwd());
  const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12);
  const name = `wrenyard-dev-${hash}`;
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`;
  return join(shortIpcBaseDir() ?? tmpdir(), `${name}.sock`);
}

const ipcPath = resolveDevIpcPath();

// 2) Child env: a copy of the inherited env (process.env is never mutated) with
//    every redirector scrubbed case-insensitively, then the dev overlay applied.
//    env_keep and unrelated WRENYARD_* selectors are left untouched.
const SCRUB_NAMES = new Set([
  'wrenyard_config_home',
  'wrenyard_state_home',
  'wrenyard_ipc_path',
  'wrenyard_workspace',
  'wrenyard_dispatch_plans_json',
  'wrenyard_task_run_id',
]);
const SCRUB_PREFIXES = ['wrenyard_gateway_'];

const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
  const lower = key.toLowerCase();
  if (SCRUB_NAMES.has(lower) || SCRUB_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    delete childEnv[key];
  }
}
childEnv.WRENYARD_CONFIG_HOME = configRoot;
childEnv.WRENYARD_STATE_HOME = stateRoot;
childEnv.WRENYARD_WORKSPACE = workspaceRoot;
childEnv.WRENYARD_IPC_PATH = ipcPath;

// 4) Resolve the pnpm CLI: the absolute inherited npm_execpath, else the
//    repository's own installed pnpm (explicit fallback, reported below).
function resolvePnpmCli() {
  const execpath = process.env.npm_execpath;
  if (execpath && isAbsolute(execpath) && existsSync(execpath)) return { script: execpath, fallback: false };
  const local = [
    join(repoRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    join(repoRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
  ].find((candidate) => existsSync(candidate));
  if (local) return { script: local, fallback: true };
  throw new Error(`cannot locate the pnpm CLI (npm_execpath=${JSON.stringify(execpath ?? null)}); run this via \`pnpm dev\` or install dependencies first.`);
}

const pnpmCli = resolvePnpmCli();

// 6) Report the chosen paths and IPC identity (never secret values).
log(`config:    ${configRoot}`);
log(`state:     ${stateRoot}`);
log(`workspace: ${workspaceRoot}`);
log(`IPC:       ${ipcPath}`);
if (pnpmCli.fallback) log(`npm_execpath is missing or not absolute; using fallback pnpm CLI ${pnpmCli.script}`);

// 4) Spawn the existing parallel daemon + desktop dev through pnpm's
//    supervisor; the daemon watch/hot-restart and Desktop behaviour are kept.
const child = spawn(
  process.execPath,
  [pnpmCli.script, '--parallel', '--filter', '@wrenyard/daemon', '--filter', '@wrenyard/desktop', 'run', 'dev'],
  { cwd: repoRoot, env: childEnv, stdio: 'inherit' },
);

// 5) Forward SIGINT/SIGTERM to the pnpm supervisor and propagate its exit code.
//    Only the direct child is signalled; unrelated processes are never killed
//    and no existing sockets/locks are touched.
let forwarded = false;
const terminate = (signal) => {
  if (forwarded) return;
  forwarded = true;
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};
process.on('SIGINT', () => terminate('SIGINT'));
process.on('SIGTERM', () => terminate('SIGTERM'));

child.on('error', (error) => {
  log(`failed to start dev processes: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (code !== null) process.exit(code);
  const number = signal ? osConstants.signals[signal] : undefined;
  process.exit(typeof number === 'number' ? 128 + number : 1);
});
