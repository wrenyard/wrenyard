import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  SHELL_CHANNELS,
  type TaskRoutingTestParams,
  type TaskRoutingTestResult,
  type TaskRoutingTestTask,
  type WrenyardShellApi,
} from '../src/shell-contract.js';
import {
  RoutingTestController,
  defaultRoutingTestForm,
  formFromTask,
  renderRoutingTestResult,
  routingTestErrorMessage,
  routingTestTaskLabel,
  serializeRoutingTestRequest,
  type RoutingTestFormState,
} from '../src/renderer/routing-test.js';

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

function resultRow(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'moonshot',
    provider_name: 'Moonshot',
    model: 'kimi-k3',
    model_name: 'Kimi K3',
    effective_tps: 42.5,
    price_score: 0.24,
    speed_score: 0.12,
    quota_score: 0.35,
    intelligence_score: 0.135,
    score: 0.845,
    rank: 1,
    reason: null,
    ...overrides,
  };
}

function routingResult(rows = [resultRow()]): TaskRoutingTestResult {
  return { rows };
}

test('routing test IPC channels and typed API surface exist', () => {
  assert.equal(SHELL_CHANNELS.taskRoutingTest, 'wrenyard-shell:task-routing-test');
  assert.equal(SHELL_CHANNELS.taskRoutingTestTasks, 'wrenyard-shell:task-routing-test-tasks');
  const api: Pick<WrenyardShellApi, 'requestTaskRoutingTest' | 'requestRoutingTestTasks'> = {
    requestTaskRoutingTest: async () => routingResult(),
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

test('shell-window validates the sender, the typed form, and disposes both channels', () => {
  const win = readFileSync(join(desktopRoot, 'src', 'shell-window.ts'), 'utf8');
  assert.match(win, /requestTaskRoutingTest\(params: TaskRoutingTestParams\): Promise<TaskRoutingTestResult>;/);
  assert.match(win, /requestRoutingTestTasks\(\): Promise<TaskRoutingTestTasksResult>;/);
  assert.match(win, /function validateTaskRoutingTestParams\(value: unknown\): TaskRoutingTestParams \{/);
  assert.match(win, /ipcMain\.handle\(SHELL_CHANNELS\.taskRoutingTest, async \(event, params: unknown\) => \{\s*assertShellSender\(event\.sender\);\s*return options\.requestTaskRoutingTest\(validateTaskRoutingTestParams\(params\)\);/);
  assert.match(win, /ipcMain\.handle\(SHELL_CHANNELS\.taskRoutingTestTasks, async \(event\) => \{\s*assertShellSender\(event\.sender\);\s*return options\.requestRoutingTestTasks\(\);/);
  assert.match(win, /SHELL_CHANNELS\.taskRoutingTestTasks,\s*\]\) ipcMain\.removeHandler\(channel\);/);
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

test('HTML hosts supply/routing tabs, keeps the supply config together, and turns routing into a form', async () => {
  const html = await readFile(join(desktopRoot, 'src', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="quota-tabs" role="tablist"/);
  assert.match(html, /data-quota-tab="supply"[^>]*>供应配置</);
  assert.match(html, /data-quota-tab="routing"[^>]*>路由测试</);
  assert.match(html, /id="quota-panel-supply" role="tabpanel"/);
  assert.match(html, /id="quota-panel-routing" role="tabpanel"[^>]*hidden/);

  const supplyStart = html.indexOf('id="quota-panel-supply"');
  const supplyEnd = html.indexOf('id="quota-panel-routing"');
  const supplyMarkup = html.slice(supplyStart, supplyEnd);
  assert.match(supplyMarkup, /id="auto-cap-title"/);
  assert.match(supplyMarkup, /id="alias-title"/);

  const routingStart = supplyEnd;
  const routingEnd = html.indexOf('id="clients-page"');
  const routingMarkup = html.slice(routingStart, routingEnd);
  assert.match(routingMarkup, /id="routing-test-run"[^>]*>测试</);
  assert.match(routingMarkup, /id="routing-test-import-select"/);
  assert.match(routingMarkup, /aria-label="Task 模板"/);
  assert.match(routingMarkup, /id="routing-test-minimum-tps"/);
  assert.match(routingMarkup, /id="routing-test-expected-tps"/);
  assert.match(routingMarkup, /id="routing-test-output-cap"/);
  assert.match(routingMarkup, /id="routing-test-require-image"[^>]*type="checkbox"/);
  assert.match(routingMarkup, /id="routing-test-require-search"[^>]*type="checkbox"/);
  assert.match(routingMarkup, /id="routing-test-exclude-models"/);
  assert.match(routingMarkup, /id="routing-test-exclude-providers"/);
  assert.ok(
    routingMarkup.indexOf('routing-test-minimum-tps') < routingMarkup.indexOf('routing-test-expected-tps'),
    'minimum TPS controls stay left of expected TPS',
  );
  assert.doesNotMatch(routingMarkup, /routing-test-import-row/);
  assert.doesNotMatch(routingMarkup, /routing-test-status/);
  assert.doesNotMatch(routingMarkup, /从 Task 导入/);
  assert.doesNotMatch(routingMarkup, /未运行/);
  assert.doesNotMatch(routingMarkup, /for="routing-test-exclude-models"/);
  assert.doesNotMatch(routingMarkup, /for="routing-test-exclude-providers"/);
  // No preset selector, verbose notes, or JSON input remains.
  assert.doesNotMatch(routingMarkup, /id="routing-test-preset"/);
  assert.doesNotMatch(routingMarkup, /routing-test-note/);
  assert.doesNotMatch(routingMarkup, /<textarea|id="routing-test-json"/);
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
    '构建（项目 core）',
  );
});

test('result table uses the exact semantic columns and shows rejected rows as dashes', () => {
  const accepted = resultRow();
  const rejected = resultRow({
    provider: 'zhipu', provider_name: 'Zhipu', model: 'glm', model_name: 'GLM',
    effective_tps: null, price_score: null, speed_score: null, quota_score: null,
    intelligence_score: null, score: null, rank: null, reason: '额度不足',
  });
  const text = collectText(renderRoutingTestResult(routingResult([accepted, rejected])));
  for (const header of ['排名', '供应商', '模型', 'TPS', '价格分', '速度分', '额度分', '智能分', '总分', '原因']) {
    assert.match(text, new RegExp(header));
  }
  assert.match(text, /0\.845/);
  assert.match(text, /42\.5/);
  assert.match(text, /额度不足/);
  // Rejected row emits dashes, never a fabricated number.
  assert.match(text, /—/);
});

test('result table preserves backend row order', () => {
  const first = resultRow({ rank: 1, provider_name: 'First' });
  const second = resultRow({ rank: 2, provider_name: 'Second' });
  const text = collectText(renderRoutingTestResult(routingResult([first, second])));
  assert.ok(text.indexOf('First') < text.indexOf('Second'), 'rows render in backend order');
});

test('empty result renders a brief empty state', () => {
  const text = collectText(renderRoutingTestResult(routingResult([])));
  assert.match(text, /暂无可用模型/);
});

test('a late response from an invalidated run is discarded and stale results cleared', async () => {
  const harness = controllerHarness();
  const first = harness.controller.run();
  assert.equal(harness.runButton.disabled, true);
  // A form change invalidates the in-flight run.
  harness.controller.onFormChanged();
  assert.equal(harness.result.childElementCount, 0, 'form change clears the stale result');
  const second = harness.controller.run();
  assert.equal(harness.queue.length, 2, 'a second run is issued after invalidation');
  // Resolve the latest request first, then let the superseded one settle late.
  harness.resolveAt(1, routingResult([resultRow({ provider_name: 'Latest' })]));
  await second;
  const afterSecond = harness.result.childElementCount;
  harness.resolveAt(0, routingResult([resultRow({ provider_name: 'Stale' })]));
  await first;
  assert.equal(harness.result.childElementCount, afterSecond, 'late response never overwrites the latest result');
  assert.match(collectText(harness.result), /Latest/);
  assert.doesNotMatch(collectText(harness.result), /Stale/);
});

test('duplicate runs are blocked while a test is in flight', async () => {
  const harness = controllerHarness();
  const first = harness.controller.run();
  assert.equal(harness.runButton.disabled, true);
  assert.equal(harness.runButton.textContent, '测试中…');
  await harness.controller.run();
  assert.equal(harness.queue.length, 1, 'second invocation is a no-op');
  harness.resolveNext(routingResult());
  await first;
  assert.equal(harness.runButton.disabled, false);
  assert.equal(harness.runButton.textContent, '测试');
});

test('importing tasks is lazy, caches a successful list, and suppresses concurrent fetches', async () => {
  const harness = controllerHarness();
  assert.equal(harness.importQueue.length, 0, 'no import happens before first interaction');
  const firstImport = harness.controller.importTasks();
  await harness.controller.importTasks();
  assert.equal(harness.importQueue.length, 1, 'concurrent fetch is suppressed');
  harness.resolveImportNext({ tasks: [importedTask()] });
  await firstImport;
  assert.equal(harness.picker.children.length, 2, 'placeholder + one imported task');
  await harness.controller.importTasks();
  assert.equal(harness.importQueue.length, 0, 'successful list is cached');
});

test('failed import stays visible in the result region and can be retried', async () => {
  const harness = controllerHarness();
  const firstImport = harness.controller.importTasks();
  harness.rejectImportNext(new Error('网关不可用'));
  await firstImport;
  assert.match(collectText(harness.result), /导入失败：网关不可用/);
  const retry = harness.controller.importTasks();
  assert.equal(harness.importQueue.length, 1, 'failure allows retry');
  harness.resolveImportNext({ tasks: [importedTask()] });
  await retry;
  assert.equal(harness.picker.children.length, 2);
});

test('selecting an imported task copies its fields and does not request a test or persist', async () => {
  const harness = controllerHarness();
  const importRun = harness.controller.importTasks();
  harness.resolveImportNext({ tasks: [importedTask()] });
  await importRun;
  harness.picker.value = 'builtin:edit';
  harness.controller.selectImportedTask();
  assert.deepEqual(harness.applied, [importedTask()]);
  assert.equal(harness.result.childElementCount, 0);
  assert.equal(harness.queue.length, 0);
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

test('an error exposes a bounded message', async () => {
  const harness = controllerHarness();
  const failing = harness.controller.run();
  harness.rejectNext(new Error("Error invoking remote method 'x': Error: 网关不可用"));
  await failing;
  assert.match(collectText(harness.result), /测试失败：网关不可用/);
  assert.equal(routingTestErrorMessage(new Error('boom')), 'boom');
});

interface Harness {
  controller: RoutingTestController;
  runButton: HTMLButtonElement;
  picker: HTMLSelectElement;
  result: HTMLElement;
  applied: TaskRoutingTestTask[];
  queue: Array<{ resolve(value: TaskRoutingTestResult): void; reject(error: unknown): void }>;
  importQueue: Array<{ resolve(value: { tasks: TaskRoutingTestTask[] }): void; reject(error: unknown): void }>;
  resolveAt(index: number, value: TaskRoutingTestResult): void;
  resolveNext(value: TaskRoutingTestResult): void;
  rejectNext(error: unknown): void;
  resolveImportNext(value: { tasks: TaskRoutingTestTask[] }): void;
  rejectImportNext(error: unknown): void;
}

function controllerHarness(): Harness {
  const runButton = fakeElement('button') as unknown as HTMLButtonElement;
  const picker = fakeElement('select') as unknown as HTMLSelectElement;
  const result = fakeElement('div') as unknown as HTMLElement;
  const queue: Array<{ resolve(value: TaskRoutingTestResult): void; reject(error: unknown): void }> = [];
  const importQueue: Array<{ resolve(value: { tasks: TaskRoutingTestTask[] }): void; reject(error: unknown): void }> = [];
  const applied: TaskRoutingTestTask[] = [];
  const controller = new RoutingTestController({
    request: () => new Promise<TaskRoutingTestResult>((resolve, reject) => { queue.push({ resolve, reject }); }),
    importTasks: () => new Promise<{ tasks: TaskRoutingTestTask[] }>((resolve, reject) => { importQueue.push({ resolve, reject }); }),
    runButton,
    taskPicker: picker,
    result,
    readForm: () => defaultRoutingTestForm(),
    applyTask: (task) => { applied.push(task); },
  });
  return {
    controller,
    runButton,
    picker,
    result,
    applied,
    queue,
    importQueue,
    resolveAt: (index, value) => { queue[index]?.resolve(value); },
    resolveNext: (value) => { queue.shift()?.resolve(value); },
    rejectNext: (error) => { queue.shift()?.reject(error); },
    resolveImportNext: (value) => { importQueue.shift()?.resolve(value); },
    rejectImportNext: (error) => { importQueue.shift()?.reject(error); },
  };
}

interface FakeElement {
  tagName: string;
  children: FakeElement[];
  childElementCount: number;
  textContent: string;
  title: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  checked: boolean;
  className: string;
  append(...nodes: unknown[]): void;
  replaceChildren(...nodes: unknown[]): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, listener: () => void): void;
}

/** Minimal DOM stand-in covering only what the routing-test module touches. */
function fakeElement(tagName: string): FakeElement {
  const element: FakeElement = {
    tagName,
    children: [],
    get childElementCount() { return element.children.length; },
    textContent: '',
    title: '',
    hidden: false,
    disabled: false,
    value: '',
    checked: false,
    className: '',
    append(...nodes: unknown[]) {
      for (const node of nodes) {
        if (isFragment(node)) element.children.push(...node.children);
        else if (isFake(node)) element.children.push(node);
      }
    },
    replaceChildren(...nodes: unknown[]) {
      element.children = [];
      element.append(...nodes);
    },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
  };
  return element;
}

function isFake(value: unknown): value is FakeElement {
  return typeof value === 'object' && value !== null && typeof (value as FakeElement).tagName === 'string';
}

interface FakeFragment {
  fragment: true;
  children: FakeElement[];
  append(...nodes: unknown[]): void;
}

function isFragment(value: unknown): value is FakeFragment {
  return typeof value === 'object' && value !== null && (value as { fragment?: unknown }).fragment === true;
}

/** Depth-first text of a real or fake node tree. */
function collectText(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  const record = node as { textContent?: string; children?: unknown[] };
  const own = typeof record.textContent === 'string' ? record.textContent : '';
  const child = Array.isArray(record.children) ? record.children.map(collectText).join(' ') : '';
  return `${own} ${child}`.trim();
}

// Bind the fake DOM into the module's document global for this test process.
(globalThis as { document?: unknown }).document = {
  createElement: (tag: string) => fakeElement(tag),
  createDocumentFragment: (): FakeFragment => {
    const fragment: FakeFragment = {
      fragment: true,
      children: [],
      append(...nodes: unknown[]) {
        for (const node of nodes) {
          if (isFragment(node)) fragment.children.push(...node.children);
          else if (isFake(node)) fragment.children.push(node);
        }
      },
    };
    return fragment;
  },
};
