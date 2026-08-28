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
    hasMore: false,
    items: [],
  };
}

test('workspace can be configured without restarting the Desktop process', async () => {
  const created: string[] = [];
  const stopped: string[] = [];
  const exits = new Map<string, (message: string) => void>();
  const controller = new DesktopConversationController({
    initialWorkspace: missingWorkspace,
    onChanged: () => undefined,
    createSession: async (workspace, onUnexpectedExit): Promise<DesktopConversationSession> => {
      created.push(workspace.path);
      exits.set(workspace.path, onUnexpectedExit);
      return {
        snapshot: () => readySnapshot(workspace),
        select: async () => readySnapshot(workspace),
        create: async () => readySnapshot(workspace),
        send: async () => readySnapshot(workspace),
        cancel: async () => readySnapshot(workspace),
        stop: () => { stopped.push(workspace.path); },
      };
    },
  });

  await controller.start();
  assert.equal(controller.snapshot().status, 'workspace-required');

  await controller.configure(configuredWorkspace('/workspace/one'));
  assert.equal(controller.snapshot().status, 'ready');
  assert.deepEqual(created, ['/workspace/one']);

  await controller.configure(configuredWorkspace('/workspace/two'));
  assert.deepEqual(created, ['/workspace/one', '/workspace/two']);
  assert.deepEqual(stopped, ['/workspace/one']);
  assert.equal(controller.snapshot().workspace.path, '/workspace/two');

  exits.get('/workspace/two')?.('DSH stopped');
  assert.equal(controller.snapshot().status, 'unavailable');
  assert.equal(controller.snapshot().message, 'DSH stopped');
  assert.deepEqual(stopped, ['/workspace/one', '/workspace/two']);
});
