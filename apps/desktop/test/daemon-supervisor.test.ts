import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DesktopDaemonSupervisor, type DaemonSupervisorOptions } from '../src/daemon-supervisor.js';

function makeOptions(overrides: Partial<DaemonSupervisorOptions> = {}): DaemonSupervisorOptions {
  return {
    launch: null,
    logsDir: '/tmp/logs',
    ipcPath: '/tmp/wrenyard.sock',
    initialProbe: { connected: false, compatible: false },
    desktopVersion: '1.0.0',
    probe: async () => ({ connected: false, compatible: false }),
    forceShutdown: async () => {},
    onChanged: () => {},
    ...overrides,
  };
}

test('without a bundled daemon, start() stays unavailable', async () => {
  const supervisor = new DesktopDaemonSupervisor(makeOptions());
  try {
    assert.equal(supervisor.mode, 'connected');
    assert.equal(supervisor.canStart(), false);

    const initial = supervisor.snapshot();
    assert.equal(initial.state, 'unavailable');
    assert.match(initial.message ?? '', /pnpm dev/);

    const snapshot = await supervisor.start();
    assert.equal(snapshot.state, 'unavailable');
    assert.equal(snapshot.pid, undefined);
  } finally {
    supervisor.dispose();
  }
});

test('a compatible reachable daemon is adopted as connected', async () => {
  const supervisor = new DesktopDaemonSupervisor(
    makeOptions({
      probe: async () => ({ connected: true, compatible: true, daemonVersion: '1.0.0' }),
    }),
  );
  try {
    const snapshot = await supervisor.start();
    assert.equal(snapshot.state, 'running');
    assert.equal(snapshot.mode, 'connected');
    assert.equal(supervisor.snapshot().state, 'running');
  } finally {
    supervisor.dispose();
  }
});

test('an already-connected daemon cannot be started even with a packaged launch', () => {
  const supervisor = new DesktopDaemonSupervisor(
    makeOptions({
      launch: {
        command: '/missing/node',
        args: ['/missing/daemon.mjs', 'run', '--config', '/c.json'],
        cwd: '/missing',
      },
      initialProbe: { connected: true, compatible: true },
    }),
  );
  try {
    const snapshot = supervisor.snapshot();
    assert.equal(snapshot.state, 'running');
    assert.equal(snapshot.mode, 'connected');
    assert.equal(snapshot.canStart, false);
    assert.equal(supervisor.canStart(), false);
  } finally {
    supervisor.dispose();
  }
});

test('an incompatible connected daemon reports both versions', () => {
  const supervisor = new DesktopDaemonSupervisor(
    makeOptions({
      initialProbe: { connected: true, compatible: false, daemonVersion: '0.9.0' },
      desktopVersion: '1.0.0',
    }),
  );
  try {
    const snapshot = supervisor.snapshot();
    assert.equal(snapshot.state, 'unavailable');
    assert.match(snapshot.message ?? '', /0\.9\.0/);
    assert.match(snapshot.message ?? '', /1\.0\.0/);
  } finally {
    supervisor.dispose();
  }
});

test('a packaged launch whose files are missing cannot start', () => {
  const supervisor = new DesktopDaemonSupervisor(
    makeOptions({
      launch: { command: '/missing/node', args: ['/missing/daemon.mjs', 'run'], cwd: '/missing' },
    }),
  );
  try {
    const snapshot = supervisor.snapshot();
    assert.equal(snapshot.mode, 'supervised');
    assert.equal(snapshot.canStart, false);
  } finally {
    supervisor.dispose();
  }
});
