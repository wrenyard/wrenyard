import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WrenyardGatewayConnection } from '@wrenyard/control-client';
import type { ConversationSnapshot, WorkspaceConfigurationSnapshot } from '@wrenyard/protocol/session';
import type { SessionBackend, StartedSessionBackend } from '../src/backend.js';
import { SessionController } from '../src/controller.js';

const missingWorkspace: WorkspaceConfigurationSnapshot = {
  status: 'missing',
  source: 'none',
  configPath: '/tmp/wrenyard/config.json',
  readOnly: false,
};

function configuredWorkspace(path: string): WorkspaceConfigurationSnapshot {
  return {
    status: 'configured',
    source: 'user-config',
    configPath: '/tmp/wrenyard/config.json',
    path,
    readOnly: false,
  };
}

/** Gateway connection the real backend would have been spawned against. */
const gatewayConnection: WrenyardGatewayConnection = {
  openaiChatBaseUrl: 'http://127.0.0.1:8787/gateway/openai-chat/v1',
  openaiResponsesBaseUrl: 'http://127.0.0.1:8787/gateway/openai-responses/v1',
  anthropicBaseUrl: 'http://127.0.0.1:8787/gateway/anthropic/v1',
  token: 'local-gateway-secret',
  models: [],
};

function readySnapshot(workspace: WorkspaceConfigurationSnapshot, selectedSessionId?: string): ConversationSnapshot {
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
    snapshot.selectedSessionId = selectedSessionId;
  }
  return snapshot;
}

type RecordingBackend = SessionBackend & { selects: string[] };

interface ControllerHarness {
  controller: SessionController;
  created: string[];
  stopped: string[];
  exits: Map<string, (message: string) => void>;
  sessions: RecordingBackend[];
}

/**
 * A SessionController whose DSH backend start is replaced by a fake factory:
 * the real backend lifecycle (workspace transitions, unexpected-exit handling,
 * recovery and selected-session restore) is exercised without a DSH child.
 */
function createControllerHarness(initialSelectedSessionId?: string): ControllerHarness {
  const created: string[] = [];
  const stopped: string[] = [];
  const exits = new Map<string, (message: string) => void>();
  const sessions: RecordingBackend[] = [];
  let nextPid = 8080;
  const controller = new SessionController({
    stateRoot: '/tmp/wrenyard/state',
    initialWorkspace: missingWorkspace,
    ipcPath: '/tmp/wrenyard/daemon.sock',
    getGatewayConnection: async () => gatewayConnection,
    waitForTaskRun: async () => undefined,
    cancelTaskRun: async () => undefined,
    summarize: async () => 'summary',
    onChanged: () => undefined,
    backendFactory: async (options): Promise<StartedSessionBackend> => {
      const workspace = options.workspace;
      created.push(workspace.path);
      exits.set(workspace.path, options.onUnexpectedExit);
      const backendProcessId = nextPid;
      nextPid += 1;
      const selects: string[] = [];
      let currentSelectedSessionId = sessions.length === 0 ? initialSelectedSessionId : undefined;
      const snapshotNow = (): ConversationSnapshot => readySnapshot(workspace, currentSelectedSessionId);
      const session: RecordingBackend = {
        backendProcessId,
        selects,
        snapshot: snapshotNow,
        select: async (sessionId) => {
          const id = String(sessionId);
          selects.push(id);
          currentSelectedSessionId = id;
          return snapshotNow();
        },
        create: async () => snapshotNow(),
        selectModel: async () => snapshotNow(),
        send: async () => snapshotNow(),
        cancel: async () => snapshotNow(),
        stop: async () => {
          stopped.push(workspace.path);
        },
      };
      sessions.push(session);
      return { backend: session, gateway: gatewayConnection };
    },
  });
  return { controller, created, stopped, exits, sessions };
}

test('workspace can be configured without restarting the Desktop process', async () => {
  const { controller, created, stopped, exits, sessions } = createControllerHarness();

  await controller.start();
  assert.equal(controller.snapshot().status, 'workspace-required');
  assert.equal(controller.backendProcessId, undefined);

  await controller.configure(configuredWorkspace('/workspace/one'));
  assert.equal(controller.snapshot().status, 'ready');
  assert.deepEqual(created, ['/workspace/one']);
  assert.equal(controller.backendProcessId, sessions[0]!.backendProcessId);

  await controller.configure(configuredWorkspace('/workspace/two'));
  assert.deepEqual(created, ['/workspace/one', '/workspace/two']);
  assert.deepEqual(stopped, ['/workspace/one']);
  assert.equal(controller.snapshot().workspace.path, '/workspace/two');
  assert.equal(controller.backendProcessId, sessions[1]!.backendProcessId);

  exits.get('/workspace/two')?.('DSH stopped');
  assert.equal(controller.snapshot().status, 'unavailable');
  assert.equal(controller.snapshot().message, 'DSH stopped');
  assert.deepEqual(stopped, ['/workspace/one', '/workspace/two']);
  assert.equal(controller.backendProcessId, undefined);

  await controller.configure(configuredWorkspace('/workspace/three'));
  assert.equal(controller.snapshot().status, 'ready');
  assert.equal(controller.backendProcessId, sessions[2]!.backendProcessId);
  await controller.close();
  assert.equal(controller.backendProcessId, undefined);
  assert.deepEqual(created, ['/workspace/one', '/workspace/two', '/workspace/three']);
  assert.deepEqual(stopped, ['/workspace/one', '/workspace/two', '/workspace/three']);
});

function selectedSessionIdOf(snapshot: { selectedSessionId?: string }): string | undefined {
  return snapshot.selectedSessionId;
}

test('recover(false) is a strict no-op while the current session is ready', async () => {
  const { controller, created, stopped, sessions } = createControllerHarness();
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
  await controller.close();
});

test('recover(false) after an unexpected exit recreates the session for the same workspace and reselects the previously selected session', async () => {
  const { controller, created, exits, sessions } = createControllerHarness('conv-1');
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
  await controller.close();
});

test('recover(true) replaces a ready session once and restores the prior selected session', async () => {
  const { controller, created, stopped, sessions } = createControllerHarness('conv-1');
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
  await controller.close();
});
