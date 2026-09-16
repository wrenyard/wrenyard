import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConversationActivityView } from '../src/renderer/conversation-activity.js';
import type { ConversationActivityItem, ConversationSnapshot, WrenyardShellApi } from '../src/shell-contract.js';

test('global activity only refreshes a paired task from the selected conversation', async () => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let scheduled: (() => void) | undefined;
  let changes = 0;
  let activity: ConversationActivityItem[] = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: true, documentElement: { dataset: { page: 'workbench' } } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout(callback: () => void) { scheduled = callback; return 1; } } });
  try {
    const source = new ConversationActivityView({ getConversationActivity: async () => activity } as WrenyardShellApi, () => { changes += 1; });
    const snapshot = { selectedSessionId: 'app-session', items: [{ id: 'tool-call', kind: 'tool', turnId: 'turn-1', toolName: 'run_task', time: 1, text: '', taskRun: { taskRunId: 'app-run', taskId: 'edit', status: 'running' } }] } as ConversationSnapshot;
    source.enrich(snapshot);
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false, documentElement: { dataset: { page: 'workbench' } } } });
    activity = [{ id: 'cli-run', taskRunId: 'cli-run', label: 'CLI task', status: 'running' }];
    scheduled!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(changes, 0);
    assert.deepEqual(source.enrich(snapshot).items.map((item) => item.taskRun?.taskRunId), ['app-run']);
    activity.push({ id: 'app-run', taskRunId: 'app-run', label: 'App task', status: 'done' });
    scheduled!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(changes, 1);
    assert.equal(source.enrich(snapshot).items[0]?.taskRun?.status, 'done');
    assert.equal(snapshot.items[0]?.taskRun?.status, 'running', 'source snapshots stay immutable');
    const switched = { ...snapshot, selectedSessionId: 'other', items: [] };
    source.enrich(switched);
    activity[1]!.status = 'failed';
    scheduled!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(changes, 1, 'the previous conversation no longer receives status changes');
    assert.deepEqual(source.enrich(switched).items, []);
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});
