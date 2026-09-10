import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  SHELL_CHANNELS,
  type TaskRoutingTestResult,
  type TaskSettingsAutomaticDispatch,
  type WrenyardShellApi,
} from '../src/shell-contract.js';
import {
  ROUTING_TEST_PRESETS,
  RoutingTestController,
  formatEffectiveRequirements,
  renderRoutingTestResult,
  routingTestErrorMessage,
  routingTestFactorRows,
  routingTestPresetLabel,
} from '../src/renderer/routing-test.js';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function effectiveRequirements(): TaskSettingsAutomaticDispatch {
  return {
    expected_tps: 20,
    minimum_tps: 10,
    intelligence_min: 'mid',
    max_output_usd_per_million: 5,
    required_capabilities: ['text'],
    exclude_provider_ids: ['deprecated'],
  };
}

function candidateRow() {
  return {
    exact_runtime: 'moonshot/kimi-k3:kimi',
    rank: 1,
    intelligence_shortfall: 0,
    reference_output_usd_per_million: 3.5,
    routing_output_usd_per_million: 2.25,
    effective_tps: 42.5,
    quota_tier: 'healthy' as const,
    quota_coverage_complete: true,
    quota_headroom_trusted: true,
    supply_class: 'standard' as const,
    price_factor: 0.8,
    speed_factor: 0.6,
    quota_factor: 1,
    intelligence_factor: 0.9,
    score: 0.83,
    notes: ['额度快照已绑定'],
  };
}

function routingResult(overrides: Partial<TaskRoutingTestResult> = {}): TaskRoutingTestResult {
  return {
    task_id: 'edit',
    effective_output_cap_usd_per_million: 5,
    effective_requirements: effectiveRequirements(),
    timeout_ms: 120_000,
    snapshot_id: 'quota-snap-1',
    now_ms: 1_700_000_000_000,
    checked_at: '2026-09-10T10:00:00.000Z',
    ranking_weights: { price: 0.3, speed: 0.2, quota: 0.35, intelligence: 0.15 },
    ordering: '先按建议智能差距从小到大，再按加权总分降序。',
    stages: { eligible: 5, quota_blocked: 1, readiness_rejected: 0, collapsed: 4, scored: 3, ranked: 3, excluded: 1 },
    candidates: [candidateRow()],
    exclusions: [{ exact_runtime: 'zhipu/glm:cc', stage: 'quota_blocked', code: 'quota_insufficient', detail: '剩余额度不足' }],
    selection: {
      exact_runtime: 'moonshot/kimi-k3:kimi',
      resolved: {
        runtime: 'moonshot/kimi-k3:kimi',
        client: 'kimi',
        provider: 'moonshot',
        model: 'kimi-k3',
        model_id: 'moonshot/kimi-k3',
        provider_display_name: 'Moonshot',
        model_display_name: 'Kimi K3',
      },
      reason: '额度健康且智能缺口最小。',
    },
    failure: null,
    static_eligibility: null,
    ...overrides,
  };
}

test('routing test exposes exactly the four read-only presets with Chinese labels', () => {
  assert.deepEqual(
    ROUTING_TEST_PRESETS.map((preset) => [preset.taskId, preset.label]),
    [
      ['edit', '编辑文件'],
      ['code-review', '变更审查'],
      ['oracle', '分析顾问'],
      ['librarian', '资料研究'],
    ],
  );
  assert.equal(routingTestPresetLabel('edit'), '编辑文件');
  assert.equal(routingTestPresetLabel('unknown-task'), 'unknown-task');
});

test('routing test IPC channel and typed API surface exist', () => {
  assert.equal(SHELL_CHANNELS.taskRoutingTest, 'wrenyard-shell:task-routing-test');
  const api: Pick<WrenyardShellApi, 'requestTaskRoutingTest'> = {
    requestTaskRoutingTest: async () => routingResult(),
  };
  assert.equal(typeof api.requestTaskRoutingTest, 'function');
});

test('preload forwards the routing test with strict string input and no raw IPC', () => {
  const preload = readFileSync(join(desktopRoot, 'src', 'preload.ts'), 'utf8');
  assert.match(
    preload,
    /requestTaskRoutingTest\(taskId: string\): Promise<TaskRoutingTestResult> \{\s*return ipcRenderer\.invoke\(SHELL_CHANNELS\.taskRoutingTest, taskId\)/,
  );
});

test('shell-window validates the sender, the bounded string input, and disposes the channel', () => {
  const win = readFileSync(join(desktopRoot, 'src', 'shell-window.ts'), 'utf8');
  assert.match(win, /requestTaskRoutingTest\(taskId: string\): Promise<TaskRoutingTestResult>;/);
  assert.match(win, /ipcMain\.handle\(SHELL_CHANNELS\.taskRoutingTest, async \(event, taskId: unknown\) => \{/);
  assert.match(win, /assertShellSender\(event\.sender\);\s*if \(typeof taskId !== 'string' \|\| !taskId \|\| taskId\.length > 512\) throw new Error\('任务 id 无效'\);/);
  assert.match(win, /return options\.requestTaskRoutingTest\(taskId\);/);
  assert.match(win, /SHELL_CHANNELS\.taskRoutingTest,\s*\]\) ipcMain\.removeHandler\(channel\);/);
});

test('main bridges task.settings.routingTest with the exact task_id param and read-only callback', () => {
  const main = readFileSync(join(desktopRoot, 'src', 'main.ts'), 'utf8');
  assert.match(main, /requestForeman\('task\.settings\.routingTest', \{ task_id: taskId \}\)/);
  assert.match(main, /const requestTaskRoutingTest = async \(taskId: string\): Promise<TaskRoutingTestResult>/);
  assert.match(main, /requestTaskRoutingTest: \(taskId: string\) => requestTaskRoutingTest\(taskId\),/);
});

test('HTML hosts supply/routing tabs, keeps the supply config together, and only a preset selector + run button', async () => {
  const html = await readFile(join(desktopRoot, 'src', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="quota-tabs" role="tablist"/);
  assert.match(html, /data-quota-tab="supply"[^>]*>供应配置</);
  assert.match(html, /data-quota-tab="routing"[^>]*>路由测试</);
  assert.match(html, /id="quota-panel-supply" role="tabpanel"/);
  assert.match(html, /id="quota-panel-routing" role="tabpanel"[^>]*hidden/);

  // Aliases and the auto cap remain together inside the first (supply) panel.
  const supplyStart = html.indexOf('id="quota-panel-supply"');
  const supplyEnd = html.indexOf('id="quota-panel-routing"');
  const supplyMarkup = html.slice(supplyStart, supplyEnd);
  assert.match(supplyMarkup, /id="auto-cap-title"/);
  assert.match(supplyMarkup, /id="alias-title"/);

  // The routing panel is only a preset selector and a run button — no
  // requirement editors and no JSON input.
  const routingStart = supplyEnd;
  const routingEnd = html.indexOf('id="clients-page"');
  const routingMarkup = html.slice(routingStart, routingEnd);
  assert.match(routingMarkup, /id="routing-test-preset"/);
  assert.match(routingMarkup, /<option value="edit">编辑文件<\/option>/);
  assert.match(routingMarkup, /<option value="code-review">变更审查<\/option>/);
  assert.match(routingMarkup, /<option value="oracle">分析顾问<\/option>/);
  assert.match(routingMarkup, /<option value="librarian">资料研究<\/option>/);
  assert.match(routingMarkup, /id="routing-test-run"[^>]*>测试路由</);
  assert.doesNotMatch(routingMarkup, /<textarea|type="number"|id="routing-test-json"/);
});

test('normalized factors are paired with the actual response weights for inspection', () => {
  const result = routingResult();
  const rows = routingTestFactorRows(result.candidates[0]!, result);
  assert.deepEqual(rows.map((row) => row.key), ['price', 'speed', 'quota', 'intelligence']);
  assert.deepEqual(rows.map((row) => row.weight), [0.3, 0.2, 0.35, 0.15]);
  assert.ok(Math.abs(rows[0]!.contribution - 0.8 * 0.3) < 1e-9);
  assert.ok(Math.abs(rows[3]!.contribution - 0.9 * 0.15) < 1e-9);
});

test('effective requirements render compactly and stay absent when unset', () => {
  assert.match(formatEffectiveRequirements(effectiveRequirements()), /期望 ≥ 20 TPS/);
  assert.match(formatEffectiveRequirements(effectiveRequirements()), /排除 提供方 1 个/);
  assert.equal(formatEffectiveRequirements({}), '无额外自动派发约束');
  assert.equal(formatEffectiveRequirements({ intelligence_min: 'low', intelligence_expected: 'mid' }), '智能最低 low · 推荐智能 mid');
});

test('candidate detail reports the backend weighted total verbatim, never a re-derived one', () => {
  const candidate = candidateRow();
  const whole = renderRoutingTestResult(routingResult());
  const detailText = collectText(whole);
  // The displayed total is the backend score; a re-derived factor sum differs.
  assert.match(detailText, /加权总分（后台计算）：0\.83/);
  const reDerived = routingTestFactorRows(candidate, routingResult())
    .reduce((sum, row) => sum + row.contribution, 0);
  assert.ok(Math.abs(reDerived - candidate.score) > 1e-9);
});

test('result shows the exact recommended runtime, timestamp, ordering, stages, and exclusions', () => {
  const text = collectText(renderRoutingTestResult(routingResult()));
  assert.match(text, /moonshot\/kimi-k3:kimi/);
  assert.match(text, /供应配置变化后请重新测试/);
  assert.match(text, /先按建议智能差距从小到大/);
  assert.match(text, /静态符合 5 · 额度阻断 1/);
  assert.match(text, /zhipu\/glm:cc/);
  assert.match(text, /额度不足|额度阻断/);
});

test('unknown or skipped evidence is surfaced without a fabricated score', () => {
  const noCandidates = routingResult({ candidates: [], selection: null });
  const text = collectText(renderRoutingTestResult(noCandidates));
  assert.match(text, /本次没有可排序的候选/);
  assert.match(text, /未选出运行配置/);
  // No numeric score line is emitted for a skipped candidate.
  assert.doesNotMatch(text, /加权总分（后台计算）：/);
  assert.doesNotMatch(text, /#0/);
});

test('a late response from an invalidated run is discarded and stale results cleared', async () => {
  const harness = controllerHarness();
  harness.preset.value = 'edit';
  const first = harness.controller.run();
  harness.preset.value = 'oracle';
  harness.controller.onPresetChanged([...ROUTING_TEST_PRESETS]);
  assert.equal(harness.result.childElementCount, 0, 'preset change clears the stale result');
  // A second run supersedes the first; both resolve, only the latest renders.
  harness.preset.value = 'code-review';
  const second = harness.controller.run();
  // Resolve the *latest* request first, then let the superseded one settle late.
  harness.resolveAt(1, routingResult({ task_id: 'code-review', candidates: [candidateRow()] }));
  await second;
  const afterSecond = harness.result.childElementCount;
  harness.resolveAt(0, routingResult({ task_id: 'edit' }));
  await first;
  assert.equal(harness.result.childElementCount, afterSecond, 'late response never overwrites the latest result');
});

test('duplicate runs are blocked while a test is in flight', async () => {
  const harness = controllerHarness();
  harness.preset.value = 'edit';
  const first = harness.controller.run();
  assert.equal(harness.runButton.disabled, true);
  assert.equal(harness.runButton.textContent, '测试中…');
  assert.equal(harness.status.textContent, '测试中…');
  // A second invocation during flight is a no-op: still only one pending request.
  await harness.controller.run();
  assert.equal(harness.pending().length, 1);
  harness.resolveNext(routingResult());
  await first;
  assert.equal(harness.runButton.disabled, false);
  assert.equal(harness.runButton.textContent, '测试路由');
});

test('an empty result reports 无候选 and error exposes a bounded message', async () => {
  const harness = controllerHarness();
  harness.preset.value = 'edit';
  const run = harness.controller.run();
  harness.resolveNext(routingResult({ candidates: [], selection: null }));
  await run;
  assert.equal(harness.status.textContent, '无候选');
  assert.match(harness.status.className, /status-pill/);

  harness.preset.value = 'oracle';
  const failing = harness.controller.run();
  harness.rejectNext(new Error("Error invoking remote method 'x': Error: 网关不可用"));
  await failing;
  assert.equal(harness.status.textContent, '失败');
  assert.match(collectText(harness.result), /测试失败：网关不可用/);
  assert.equal(routingTestErrorMessage(new Error('boom')), 'boom');
});

interface Harness {
  controller: RoutingTestController;
  preset: HTMLSelectElement;
  runButton: HTMLButtonElement;
  status: HTMLElement;
  result: HTMLElement;
  pending(): Array<{ resolve(value: TaskRoutingTestResult): void; reject(error: unknown): void }>;
  resolveAt(index: number, value: TaskRoutingTestResult): void;
  resolveNext(value: TaskRoutingTestResult): void;
  rejectNext(error: unknown): void;
}

function controllerHarness(): Harness {
  const preset = fakeElement('select') as unknown as HTMLSelectElement;
  const runButton = fakeElement('button') as unknown as HTMLButtonElement;
  const status = fakeElement('p') as unknown as HTMLElement;
  const result = fakeElement('div') as unknown as HTMLElement;
  const queue: Array<{ resolve(value: TaskRoutingTestResult): void; reject(error: unknown): void }> = [];
  const controller = new RoutingTestController({
    request: () => new Promise<TaskRoutingTestResult>((resolve, reject) => { queue.push({ resolve, reject }); }),
    presetSelect: preset,
    runButton,
    status,
    result,
  });
  return {
    controller,
    preset,
    runButton,
    status,
    result,
    pending: () => [...queue],
    resolveAt: (index, value) => { queue[index]?.resolve(value); },
    resolveNext: (value) => { queue.shift()?.resolve(value); },
    rejectNext: (error) => { queue.shift()?.reject(error); },
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
