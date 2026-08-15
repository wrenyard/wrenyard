import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './lib/xdg.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const logDir = join(stateDir(), 'logs');
const logFile = join(logDir, 'pet.log');
let stopping = false;
let exited = false;

mkdirSync(logDir, { recursive: true });

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const fd = openSync(logFile, 'a');

const child = spawn(electronPath, ['.'], {
  cwd: repoRoot,
  detached: false,
  stdio: ['ignore', fd, fd],
  windowsHide: true,
});

child.on('exit', (code, signal) => {
  exited = true;
  if (signal) {
    console.log(`Electron exited with signal ${signal}`);
  } else {
    console.log(`Electron exited with code ${code}`);
  }
  process.exit(stopping ? 0 : (code ?? (signal ? 1 : 0)));
});

child.on('error', (err) => {
  console.error('Failed to spawn electron:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => stopChild());
process.on('SIGTERM', () => stopChild());

console.log(`Foreman Pet started (pid ${child.pid})`);
console.log(`Logs: ${logFile}`);

function stopChild() {
  if (stopping) return;
  stopping = true;
  if (!child.pid || exited) {
    process.exit(0);
  }

  child.kill('SIGTERM');
  setTimeout(() => {
    if (exited) return;
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // Best effort; Foreman owns outer lifecycle cleanup.
    }
  }, 5000).unref();
}
