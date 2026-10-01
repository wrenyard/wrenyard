import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  SHELL_CHANNELS,
  type TaskRoutingTestParams,
  type TaskRoutingTestTask,
  type WrenyardShellApi,
} from '../src/shell-contract.js';
import {
  defaultRoutingTestForm,
  formFromTask,
  routingTestErrorMessage,
  routingTestTaskLabel,
  serializeRoutingTestRequest,
  type RoutingTestFormState,
} from '../src/renderer/pages/quota/model/routing.js';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function importedTask(overrides: Partial<TaskRoutingTestTask> = {}): TaskRoutingTestTask {
  return {
    identity: 'builtin:edit',
    name: 'edit',
    display_name: '编辑文件',
    automatic: {
      expected_tps: 20,
      minimum_tps: 10,
      intelligence_min: 'mid',
      intelligence_expected: 'premium',
      max_output_usd_per_million: 5,
      required_capabilities: ['text', 'image'],
      requires_web_search: true,
      exclude_model_ids: ['legacy-model'],
      exclude_profile_ids: ['legacy-profile'],
      exclude_provider_ids: ['legacy-provider'],
      exclude_client_ids: ['legacy-client'],
    },
    timeout_ms: 120_000,
    ...overrides,
  };
}

test('routing test IPC channels and typed API surface exist', () => {
  assert.equal(SHELL_CHANNELS.taskRoutingTest, 'wrenyard-shell:task-routing-test');
  assert.equal(SHELL_CHANNELS.taskRoutingTestTasks, 'wrenyard-shell:task-routing-test-tasks');
  const api: Pick<WrenyardShellApi, 'requestTaskRoutingTest' | 'requestRoutingTestTasks'> = {
    requestTaskRoutingTest: async () => ({ rows: [] }),
    requestRoutingTestTasks: async () => ({ tasks: [importedTask()] }),
  };
  assert.equal(typeof api.requestTaskRoutingTest, 'function');
  assert.equal(typeof api.requestRoutingTestTasks, 'function');
});

test('preload forwards the typed form request and lazily imports tasks without raw IPC', () => {
  const preload = readFileSync(join(desktopRoot, 'src', 'preload.ts'), 'utf8');
  assert.match(
    preload,
    /requestTaskRoutingTest\(params: TaskRoutingTestParams\): Promise<TaskRoutingTestResult> \{\s*return ipcRenderer\.invoke\(SHELL_CHANNELS\.taskRoutingTest, params\)/,
  );
  assert.match(
    preload,
    /requestRoutingTestTasks\(\): Promise<TaskRoutingTestTasksResult> \{\s*return ipcRenderer\.invoke\(SHELL_CHANNELS\.taskRoutingTestTasks\)/,
  );
});

/** Every channel named in the removeIpcHandlers disposal list. */
function disposedChannels(win: string): string[] {
  const start = win.indexOf('private removeIpcHandlers(): void {');
  assert.ok(start >= 0, 'shell-window must dispose its IPC handlers');
  const loop = win.indexOf('ipcMain.removeHandler(channel)', start);
  assert.ok(loop > start, 'the disposal loop removes every registered channel');
  const list = win.slice(start, loop);
  return [...list.matchAll(/SHELL_CHANNELS\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
}

test('shell-window validates the sender, the typed form, and disposes both channels', () => {
  const win = readFileSync(join(desktopRoot, 'src', 'shell-window.ts'), 'utf8');
  assert.match(win, /requestTaskRoutingTest\(params: TaskRoutingTestParams\): Promise<TaskRoutingTestResult>;/);
  assert.match(win, /requestRoutingTestTasks\(\): Promise<TaskRoutingTestTasksResult>;/);
  assert.match(win, /function validateTaskRoutingTestParams\(value: unknown\): TaskRoutingTestParams \{/);
  assert.match(win, /ipcMain\.handle\(SHELL_CHANNELS\.taskRoutingTest, async \(event, params: unknown\) => \{\s*assertShellSender\(event\.sender\);\s*return options\.requestTaskRoutingTest\(validateTaskRoutingTestParams\(params\)\);/);
  assert.match(win, /ipcMain\.handle\(SHELL_CHANNELS\.taskRoutingTestTasks, async \(event\) => \{\s*assertShellSender\(event\.sender\);\s*return options\.requestRoutingTestTasks\(\);/);

  // Both routing channels are disposed, and neither is assumed to be the last
  // entry: the list grows as handlers are added, so membership is the contract.
  const disposed = disposedChannels(win);
  assert.ok(disposed.includes('taskRoutingTest'), 'the routing test channel is disposed');
  assert.ok(disposed.includes('taskRoutingTestTasks'), 'the routing tasks import channel is disposed');
  assert.ok(disposed.length > 0, 'the disposal list is non-empty');
  assert.equal(new Set(disposed).size, disposed.length, 'no channel is disposed twice');
});

test('main bridges the typed form request and routingTestTasks import with requestForeman', () => {
  const main = readFileSync(join(desktopRoot, 'src', 'main.ts'), 'utf8');
  assert.match(main, /requestForeman\('task\.settings\.routingTest', request\)/);
  assert.match(main, /requestForeman\('task\.settings\.routingTestTasks', \{\}\)/);
  assert.match(main, /const requestTaskRoutingTest = async \(params: TaskRoutingTestParams\): Promise<TaskRoutingTestResult>/);
  assert.match(main, /const requestRoutingTestTasks = async \(\): Promise<TaskRoutingTestTasksResult>/);
  assert.match(main, /requestTaskRoutingTest: \(params: TaskRoutingTestParams\) => requestTaskRoutingTest\(params\),/);
  assert.match(main, /requestRoutingTestTasks: \(\) => requestRoutingTestTasks\(\),/);
});

test('default form has recommended mid with no minimum or extra capabilities', () => {
  const request = serializeRoutingTestRequest(defaultRoutingTestForm());
  assert.deepEqual(request, { automatic: { intelligence_expected: 'mid' } });
  assert.equal('expected_tps' in request.automatic, false);
  assert.equal('minimum_tps' in request.automatic, false);
  assert.equal('max_output_usd_per_million' in request.automatic, false);
  assert.equal('intelligence_min' in request.automatic, false);
  assert.equal('timeout_ms' in request, false);
});

test('form serialization carries numbers, capabilities, search, and exclusion arrays', () => {
  const form: RoutingTestFormState = {
    ...defaultRoutingTestForm(),
    expectedTps: '30',
    minimumTps: '12.5',
    maxOutputUsdPerMillion: '4',
    intelligenceMin: 'high',
    intelligenceExpected: 'premium',
    requireText: true,
    requireImage: true,
    requireWebSearch: true,
    excludeModelIds: ['legacy-a', 'legacy-b', 'legacy-a'],
    excludeProviderIds: ['old-provider'],
    timeoutMs: '90000',
  };
  const request = serializeRoutingTestRequest(form);
  assert.equal(request.automatic.expected_tps, 30);
  assert.equal(request.automatic.minimum_tps, 12.5);
  assert.equal(request.automatic.max_output_usd_per_million, 4);
  assert.equal(request.automatic.intelligence_min, 'high');
  assert.deepEqual(request.automatic.required_capabilities, ['text', 'image']);
  assert.equal(request.automatic.requires_web_search, true);
  assert.deepEqual(request.automatic.exclude_model_ids, ['legacy-a', 'legacy-b']);
  assert.deepEqual(request.automatic.exclude_provider_ids, ['old-provider']);
  assert.equal(request.timeout_ms, 90000);
});

test('invalid numeric form input is rejected rather than silently ignored', () => {
  const form = { ...defaultRoutingTestForm(), expectedTps: 'abc' };
  assert.throws(() => serializeRoutingTestRequest(form), /大于 0/);
});

test('copying a task preserves capabilities, exclusions, and timeout verbatim', () => {
  const form = formFromTask(importedTask());
  assert.equal(form.expectedTps, '20');
  assert.equal(form.minimumTps, '10');
  assert.equal(form.maxOutputUsdPerMillion, '5');
  assert.equal(form.intelligenceMin, 'mid');
  assert.equal(form.intelligenceExpected, 'premium');
  assert.equal(form.requireImage, true);
  assert.equal(form.requireWebSearch, true);
  assert.deepEqual(form.excludeModelIds, ['legacy-model']);
  assert.deepEqual(form.excludeProviderIds, ['legacy-provider']);
  assert.deepEqual(form.excludeProfileIds, ['legacy-profile']);
  assert.deepEqual(form.excludeClientIds, ['legacy-client']);
  assert.equal(form.timeoutMs, '120000');

  // Round-trip through serialization keeps the imported exclusions/capabilities.
  const request: TaskRoutingTestParams = serializeRoutingTestRequest(form);
  assert.deepEqual(request.automatic.exclude_profile_ids, ['legacy-profile']);
  assert.deepEqual(request.automatic.exclude_client_ids, ['legacy-client']);
  assert.deepEqual(request.automatic.required_capabilities, ['text', 'image']);
  assert.equal(request.automatic.requires_web_search, true);
});

test('picker labels distinguish project tasks and Chinese names', () => {
  assert.equal(routingTestTaskLabel(importedTask()), '编辑文件');
  assert.equal(
    routingTestTaskLabel(importedTask({ identity: 'project:core:build', project: 'core', display_name: '构建' })),
    '构建 · core',
  );
  assert.equal(
    routingTestTaskLabel(importedTask({ identity: 'project:gol:build', project: 'gol', display_name: '构建' })),
    '构建 · GOL',
  );
});

test('template unknown model and provider exclusions are preserved', () => {
  const form = formFromTask(importedTask({
    automatic: {
      ...importedTask().automatic,
      exclude_model_ids: ['unknown-model'],
      exclude_provider_ids: ['unknown-provider'],
    },
  }));
  assert.deepEqual(form.excludeModelIds, ['unknown-model']);
  assert.deepEqual(form.excludeProviderIds, ['unknown-provider']);
  const request = serializeRoutingTestRequest(form);
  assert.deepEqual(request.automatic.exclude_model_ids, ['unknown-model']);
  assert.deepEqual(request.automatic.exclude_provider_ids, ['unknown-provider']);
});

test('an error exposes a bounded message', () => {
  assert.equal(routingTestErrorMessage(new Error('boom')), 'boom');
  assert.equal(
    routingTestErrorMessage(new Error("Error invoking remote method 'x': Error: 网关不可用")),
    '网关不可用',
  );
});
