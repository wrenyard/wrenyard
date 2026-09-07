import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DesktopConversationController,
  type ConfiguredWorkspace,
  type DesktopConversationSession,
} from '../src/conversation-controller.js';
import type { ConversationSnapshot, WorkspaceConfigurationSnapshot } from '../src/shell-contract.js';

const missingWorkspace: WorkspaceConfigurationSnapshot = {
  status: 'missing',
  source: 'none',
  configPath: '/tmp/wrenyard/config.json',
  readOnly: false,
};

function configuredWorkspace(path: string): ConfiguredWorkspace {
  return {
    status: 'configured',
    source: 'user-config',
    configPath: '/tmp/wrenyard/config.json',
    path,
    readOnly: false,
  };
}

function readySnapshot(workspace: ConfiguredWorkspace, selectedSessionId?: string): ConversationSnapshot {
  const snapshot: ConversationSnapshot = {
    status: 'ready',
    workspace,
    sessions: [],
    selectedRunning: false,
    models: { status: 'idle', groups: [] },
    hasMore: false,
    items: [],
  };
  if (selectedSessionId !== undefined) {
    (snapshot as { selectedSessionId?: string }).selectedSessionId = selectedSessionId;
  }
  return snapshot;
}

test('workspace can be configured without restarting the Desktop process', async () => {
  const created: string[] = [];
  const stopped: string[] = [];
  const exits = new Map<string, (message: string) => void>();
  const sessionPids = new Map<string, number>();
  let nextPid = 4242;
  const controller = new DesktopConversationController({
    initialWorkspace: missingWorkspace,
    onChanged: () => undefined,
    createSession: async (workspace, onUnexpectedExit): Promise<DesktopConversationSession> => {
      created.push(workspace.path);
      exits.set(workspace.path, onUnexpectedExit);
      const backendProcessId = nextPid;
      nextPid += 1;
      sessionPids.set(workspace.path, backendProcessId);
      return {
        backendProcessId,
        snapshot: () => readySnapshot(workspace),
        select: async () => readySnapshot(workspace),
        create: async () => readySnapshot(workspace),
        selectModel: async () => readySnapshot(workspace),
        send: async () => readySnapshot(workspace),
        cancel: async () => readySnapshot(workspace),
        stop: () => { stopped.push(workspace.path); },
      };
    },
  });

  await controller.start();
  assert.equal(controller.snapshot().status, 'workspace-required');
  assert.equal(controller.backendProcessId, undefined);

  await controller.configure(configuredWorkspace('/workspace/one'));
  assert.equal(controller.snapshot().status, 'ready');
  assert.deepEqual(created, ['/workspace/one']);
  assert.equal(controller.backendProcessId, sessionPids.get('/workspace/one'));

  await controller.configure(configuredWorkspace('/workspace/two'));
  assert.deepEqual(created, ['/workspace/one', '/workspace/two']);
  assert.deepEqual(stopped, ['/workspace/one']);
  assert.equal(controller.snapshot().workspace.path, '/workspace/two');
  assert.equal(controller.backendProcessId, sessionPids.get('/workspace/two'));

  exits.get('/workspace/two')?.('DSH stopped');
  assert.equal(controller.snapshot().status, 'unavailable');
  assert.equal(controller.snapshot().message, 'DSH stopped');
  assert.deepEqual(stopped, ['/workspace/one', '/workspace/two']);
  assert.equal(controller.backendProcessId, undefined);

  await controller.configure(configuredWorkspace('/workspace/three'));
  assert.equal(controller.snapshot().status, 'ready');
  assert.equal(controller.backendProcessId, sessionPids.get('/workspace/three'));
  await controller.stop();
  assert.equal(controller.backendProcessId, undefined);
  assert.deepEqual(created, ['/workspace/one', '/workspace/two', '/workspace/three']);
  assert.deepEqual(stopped, ['/workspace/one', '/workspace/two', '/workspace/three']);
});

type RecordingSession = DesktopConversationSession & { selects: string[] };

interface RecoveryHarness {
  controller: DesktopConversationController;
  created: string[];
  stopped: string[];
  exits: Map<string, (message: string) => void>;
  sessions: RecordingSession[];
}

function selectedSessionIdOf(snapshot: { selectedSessionId?: string }): string | undefined {
  return snapshot.selectedSessionId;
}

function createRecoveryHarness(initialSelectedSessionId?: string): RecoveryHarness {
  const created: string[] = [];
  const stopped: string[] = [];
  const exits = new Map<string, (message: string) => void>();
  const sessions: RecordingSession[] = [];
  let nextPid = 8080;
  const controller = new DesktopConversationController({
    initialWorkspace: missingWorkspace,
    onChanged: () => undefined,
    createSession: async (workspace, onUnexpectedExit): Promise<DesktopConversationSession> => {
      created.push(workspace.path);
      exits.set(workspace.path, onUnexpectedExit);
      const backendProcessId = nextPid;
      nextPid += 1;
      const selects: string[] = [];
      let currentSelectedSessionId = sessions.length === 0 ? initialSelectedSessionId : undefined;
      const snapshotNow = (): ConversationSnapshot => readySnapshot(workspace, currentSelectedSessionId);
      const session: RecordingSession = {
        backendProcessId,
        selects,
        snapshot: snapshotNow,
        select: async (sessionId?) => {
          const id = String(sessionId);
          selects.push(id);
          currentSelectedSessionId = id;
          return snapshotNow();
        },
        create: async () => snapshotNow(),
        selectModel: async () => snapshotNow(),
        send: async () => snapshotNow(),
        cancel: async () => snapshotNow(),
        stop: () => {
          stopped.push(workspace.path);
        },
      };
      sessions.push(session);
      return session;
    },
  });
  return { controller, created, stopped, exits, sessions };
}

test('recover(false) is a strict no-op while the current session is ready', async () => {
  const { controller, created, stopped, sessions } = createRecoveryHarness();
  await controller.start();
  await controller.configure(configuredWorkspace('/workspace/one'));
  assert.equal(controller.snapshot().status, 'ready');
  const pidBefore = controller.backendProcessId;
  const createdBefore = [...created];
  const stoppedBefore = [...stopped];
  const selectCallsBefore = sessions.map((session) => [...session.selects]);

  await controller.recover(false);

  assert.deepEqual(created, createdBefore);
  assert.deepEqual(stopped, stoppedBefore);
  assert.deepEqual(sessions.map((session) => [...session.selects]), selectCallsBefore);
  assert.equal(controller.backendProcessId, pidBefore);
  assert.equal(controller.snapshot().status, 'ready');
  await controller.stop();
});

test('recover(false) after an unexpected exit recreates the session for the same workspace and reselects the previously selected session', async () => {
  const { controller, created, exits, sessions } = createRecoveryHarness('conv-1');
  await controller.start();
  await controller.configure(configuredWorkspace('/workspace/one'));
  assert.equal(controller.snapshot().status, 'ready');
  assert.equal(controller.backendProcessId, sessions[0]?.backendProcessId);

  exits.get('/workspace/one')?.('DSH exited unexpectedly');
  assert.equal(controller.snapshot().status, 'unavailable');
  assert.equal(controller.backendProcessId, undefined);

  await controller.recover(false);

  assert.equal(controller.snapshot().status, 'ready');
  assert.deepEqual(created, ['/workspace/one', '/workspace/one']);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[1]?.selects, ['conv-1']);
  assert.equal(selectedSessionIdOf(controller.snapshot()), 'conv-1');
  assert.equal(controller.backendProcessId, sessions[1]?.backendProcessId);
  await controller.stop();
});

test('recover(true) replaces a ready session once and restores the prior selected session', async () => {
  const { controller, created, stopped, sessions } = createRecoveryHarness('conv-1');
  await controller.start();
  await controller.configure(configuredWorkspace('/workspace/one'));
  assert.equal(controller.snapshot().status, 'ready');
  const originalBackendProcessId = controller.backendProcessId;

  await controller.recover(true);

  assert.equal(controller.snapshot().status, 'ready');
  assert.deepEqual(created, ['/workspace/one', '/workspace/one']);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[1]?.selects, ['conv-1']);
  assert.equal(selectedSessionIdOf(controller.snapshot()), 'conv-1');
  assert.notEqual(controller.backendProcessId, originalBackendProcessId);
  assert.equal(controller.backendProcessId, sessions[1]?.backendProcessId);
  assert.deepEqual(stopped, ['/workspace/one']);
  await controller.stop();
});
