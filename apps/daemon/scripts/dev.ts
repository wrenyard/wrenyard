// Source development runner for the daemon: runs lib/main.mts through tsx and
// restarts it, once idle, after a daemon or shared-package source change.
// Desktop is not managed here; a source Desktop only connects and waits.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveWrenyardIpcPath } from '@wrenyard/control-client';
import { DaemonProcess, ipcCall } from '../lib/supervisor.mjs';
import { resolveForemanConfigPath } from '../lib/config/path.mts';

interface DaemonStatus { idle?: boolean; activeTaskCount?: number; activeTaskGraphCount?: number; activeExecutionCount?: number }
interface HealthPing { ok?: boolean; identity?: { mode?: string; version?: string } }

const daemonRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkout = resolve(daemonRoot, '..', '..');
const watchRoots = [daemonRoot, join(checkout, 'packages')];
const ignoredDirs = new Set(['node_modules', 'dist', '.git', 'coverage', 'test', 'tests', '__tests__']);
const ipcPath = resolveWrenyardIpcPath();
const configPath = resolveForemanConfigPath();
const tsxDir = dirname(createRequire(join(daemonRoot, 'package.json')).resolve('tsx/cli'));
const print = (text: string): void => { process.stdout.write(`[daemon dev] ${text}\n`); };
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

let daemon: DaemonProcess | null = null;
let stopping = false;
let restarting: Promise<void> | null = null;
let pendingRestart = false;

async function rpc<T>(method: string): Promise<T> {
  return await ipcCall(ipcPath, method, {}, 2_000) as T;
}

function launch(): DaemonProcess {
  const proc: DaemonProcess = new DaemonProcess({
    command: process.execPath,
    args: ['--require', join(tsxDir, 'preflight.cjs'), '--import', pathToFileURL(join(tsxDir, 'loader.mjs')).href,
      join(daemonRoot, 'lib', 'main.mts'), 'run', '--config', configPath],
    cwd: checkout,
    env: process.env,
    ipcPath,
    readyTimeoutMs: 60_000,
    stopTimeoutMs: 120_000,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    onExit: (info: { code: number | null; signal: string | null; expected: boolean }) => {
      if (daemon !== proc) return;
      daemon = null;
      if (stopping || info.expected) return;
      if (info.code === 0 && info.signal === null) {
        print('daemon exited cleanly; starting it again.');
        void start();
      } else {
        print(`daemon exited (code ${info.code}, signal ${info.signal}); save a source file to retry.`);
      }
    },
  });
  return proc;
}

async function start(): Promise<void> {
  if (stopping || daemon) return;
  const proc = launch();
  daemon = proc;
  try {
    await proc.launch();
    print(`daemon ready (pid ${proc.pid}, IPC ${ipcPath}).`);
  } catch (error) {
    if (daemon === proc) daemon = null;
    print(`daemon failed to start: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function typecheck(): Promise<boolean> {
  print('type checking daemon...');
  return new Promise(done => {
    const child = spawn(process.execPath, [createRequire(join(daemonRoot, 'package.json')).resolve('typescript/bin/tsc'), '--noEmit', '-p', join(daemonRoot, 'tsconfig.startup.json')],
      { cwd: daemonRoot, stdio: 'inherit', windowsHide: true });
    child.once('error', () => done(false));
    child.once('exit', code => done(code === 0));
  });
}

async function waitIdle(): Promise<void> {
  let noticeAt = 0;
  while (!stopping && daemon) {
    let status: DaemonStatus;
    try { status = await rpc<DaemonStatus>('daemon.status'); } catch { return; }
    if (status.idle === true) return;
    if (Date.now() - noticeAt >= 30_000) {
      noticeAt = Date.now();
      print(`waiting for idle before restart (tasks ${status.activeTaskCount ?? 0}, task graphs ${status.activeTaskGraphCount ?? 0}, executions ${status.activeExecutionCount ?? 0}; conversations also count).`);
    }
    await sleep(1_000);
  }
}

async function restart(): Promise<void> {
  if (restarting) { pendingRestart = true; return; }
  restarting = (async () => {
    do {
      pendingRestart = false;
      if (!await typecheck()) { print('type check failed; the running daemon is kept. Fix the source and save.'); continue; }
      await waitIdle();
      if (stopping) return;
      const proc = daemon;
      if (proc) {
        daemon = null;
        if (!await proc.shutdown()) { print(`daemon ${proc.pid} did not exit; restart abandoned.`); daemon = proc; continue; }
      }
      await start();
    } while (pendingRestart && !stopping);
  })().finally(() => { restarting = null; });
}

function snapshot(): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ignoredDirs.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|json|ya?ml|md)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
        try { files.set(path, createHash('sha256').update(readFileSync(path)).digest('hex')); } catch { /* Deleted mid-scan. */ }
      }
    }
  };
  for (const root of watchRoots) if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) visit(root);
  return files;
}

function watchSources(): () => void {
  let known = snapshot();
  let timer: NodeJS.Timeout | undefined;
  const watchers = watchRoots.map(root => watch(root, { recursive: true }, (_event, name) => {
    if (name && relative(root, join(root, name.toString())).split(/[\\/]/).some(part => ignoredDirs.has(part))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const next = snapshot();
      const changed = [...new Set([...known.keys(), ...next.keys()])].filter(file => known.get(file) !== next.get(file));
      known = next;
      if (!changed.length) return;
      print(`source changed: ${changed.slice(0, 3).map(file => relative(checkout, file)).join(', ')}${changed.length > 3 ? ` (+${changed.length - 3})` : ''}`);
      void restart();
    }, 300);
  }));
  return () => { if (timer) clearTimeout(timer); watchers.forEach(watcher => watcher.close()); };
}

async function main(): Promise<void> {
  try {
    const health = await rpc<HealthPing>('health.ping');
    print(`a daemon is already running (${health.identity?.mode ?? 'unknown'} ${health.identity?.version ?? ''}) on ${ipcPath}; stop it first.`);
    process.exitCode = 1;
    return;
  } catch { /* No daemon: this runner owns one. */ }
  const closeWatchers = watchSources();
  process.on('SIGINT', () => {
    if (stopping) {
      print('forcing daemon shutdown...');
      void daemon?.shutdown({ force: true, timeoutMs: 10_000 });
      return;
    }
    stopping = true;
    closeWatchers();
    print('stopping daemon; waiting for active work to drain (Ctrl+C again to force)...');
    void (async () => {
      await restarting;
      await daemon?.shutdown();
      process.exit(0);
    })();
  });
  await start();
}

await main();
