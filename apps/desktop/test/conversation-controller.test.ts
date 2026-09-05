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

function readySnapshot(workspace: ConfiguredWorkspace): ConversationSnapshot {
  return {
    status: 'ready',
    workspace,
    sessions: [],
    selectedRunning: false,
    models: { status: 'idle', groups: [] },
    hasMore: false,
    items: [],
  };
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
