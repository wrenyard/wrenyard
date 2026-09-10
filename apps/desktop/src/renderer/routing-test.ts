import type {
  TaskRoutingTestParams,
  TaskRoutingTestResult,
  TaskRoutingTestRow,
  TaskRoutingTestTask,
  TaskSettingsAutomaticDispatch,
} from '../shell-contract.js';

/**
 * Form-first routing-test renderer helpers/controller.
 *
 * This module only serializes the typed form into a `TaskRoutingTestParams`
 * request, lazily imports raw task definitions, and displays the daemon-owned
 * flattened result. It never computes routing, ranking, or scores: every
 * number shown comes verbatim from the backend response.
 */

/** Exact automatic-dispatch field keys, in a stable form-control order. */
export const ROUTING_TEST_AUTOMATIC_KEYS = [
  'expected_tps',
  'minimum_tps',
  'intelligence_min',
  'intelligence_expected',
  'max_output_usd_per_million',
  'required_capabilities',
  'requires_web_search',
  'exclude_model_ids',
  'exclude_profile_ids',
  'exclude_client_ids',
  'exclude_provider_ids',
] as const;

/**
 * Editable form state. Every field mirrors the automatic constraint it
 * serializes; empty strings are "unset" and are omitted from the request.
 * Imported exclusions are held verbatim so an imported capability set or
 * exclusion list is never silently lost.
 */
export interface RoutingTestFormState {
  /** Decimal text for expected/minimum TPS and the reference output cap. */
  expectedTps: string;
  minimumTps: string;
  maxOutputUsdPerMillion: string;
  /** Selected intelligence requirement, or '' when unset. */
  intelligenceMin: string;
  intelligenceExpected: string;
  /** Requires image input capability (`required_capabilities` contains image). */
  requireImage: boolean;
  /** Requires web search (`requires_web_search`). */
  requireWebSearch: boolean;
  /** Newline/comma text for imported model exclusions. */
  excludeModelIds: string;
  /** Newline/comma text for imported provider exclusions. */
  excludeProviderIds: string;
  /** Imported profile exclusions, held verbatim; not edited by the form UI. */
  excludeProfileIds: string[];
  /** Imported client exclusions, held verbatim; not edited by the form UI. */
  excludeClientIds: string[];
  /** Always requested when this form is submitted. */
  requireText: boolean;
  /** Optional request timeout in milliseconds, or '' when unset. */
  timeoutMs: string;
}

/** Blank form defaults: no minimum/recommended mid, no cap, text-only. */
export function defaultRoutingTestForm(): RoutingTestFormState {
  return {
    expectedTps: '',
    minimumTps: '',
    maxOutputUsdPerMillion: '',
    intelligenceMin: '',
    intelligenceExpected: 'mid',
    requireImage: false,
    requireWebSearch: false,
    excludeModelIds: '',
    excludeProviderIds: '',
    excludeProfileIds: [],
    excludeClientIds: [],
    requireText: false,
    timeoutMs: '',
  };
}

function parsePositiveNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) throw new Error('请输入大于 0 的数值');
  return value;
}

function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Serializes the editable form into the exact typed request. Unset fields are
 * omitted rather than sent as null/zero; imported exclusions and capability
 * requirements are preserved verbatim.
 */
export function serializeRoutingTestRequest(form: RoutingTestFormState): TaskRoutingTestParams {
  const automatic: Partial<TaskSettingsAutomaticDispatch> = {};
  const expectedTps = parsePositiveNumber(form.expectedTps);
  if (expectedTps !== null) automatic.expected_tps = expectedTps;
  const minimumTps = parsePositiveNumber(form.minimumTps);
  if (minimumTps !== null) automatic.minimum_tps = minimumTps;
  if (form.intelligenceMin) automatic.intelligence_min = form.intelligenceMin as TaskSettingsAutomaticDispatch['intelligence_min'];
  if (form.intelligenceExpected) automatic.intelligence_expected = form.intelligenceExpected as TaskSettingsAutomaticDispatch['intelligence_expected'];
  const tiers = ['low', 'mid', 'high', 'premium'];
  if (form.intelligenceMin && tiers.indexOf(form.intelligenceExpected) < tiers.indexOf(form.intelligenceMin)) throw new Error('推荐智能不能低于最低智能');
  if (expectedTps !== null && minimumTps !== null && expectedTps < minimumTps) throw new Error('期望 TPS 不能低于最低 TPS');
  const cap = parsePositiveNumber(form.maxOutputUsdPerMillion);
  if (cap !== null) automatic.max_output_usd_per_million = cap;

  const capabilities: Array<'text' | 'image'> = [];
  if (form.requireText) capabilities.push('text');
  if (form.requireImage) capabilities.push('image');
  if (capabilities.length > 0) automatic.required_capabilities = capabilities;
  if (form.requireWebSearch) automatic.requires_web_search = true;

  const excludeModelIds = unique(splitList(form.excludeModelIds));
  if (excludeModelIds.length > 0) automatic.exclude_model_ids = excludeModelIds;
  const excludeProviderIds = unique(splitList(form.excludeProviderIds));
  if (excludeProviderIds.length > 0) automatic.exclude_provider_ids = excludeProviderIds;
  const excludeProfileIds = unique(form.excludeProfileIds);
  if (excludeProfileIds.length > 0) automatic.exclude_profile_ids = excludeProfileIds;
  const excludeClientIds = unique(form.excludeClientIds);
  if (excludeClientIds.length > 0) automatic.exclude_client_ids = excludeClientIds;

  const params: TaskRoutingTestParams = { automatic: automatic as TaskSettingsAutomaticDispatch };
  const timeoutMs = Number(form.timeoutMs.trim());
  if (form.timeoutMs.trim().length > 0 && Number.isSafeInteger(timeoutMs) && timeoutMs > 0) {
    params.timeout_ms = timeoutMs;
  }
  return params;
}

/**
 * Copies a task's raw automatic configuration and timeout into editable form
 * state. Imported capability requirements and exclusions are preserved: the
 * form only surfaces image/search checkboxes plus model/provider exclusions,
 * so profile/client exclusions are carried through unchanged.
 */
export function formFromTask(task: TaskRoutingTestTask): RoutingTestFormState {
  const automatic = task.automatic;
  const form = defaultRoutingTestForm();
  if (automatic.expected_tps !== undefined) form.expectedTps = String(automatic.expected_tps);
  if (automatic.minimum_tps !== undefined) form.minimumTps = String(automatic.minimum_tps);
  if (automatic.max_output_usd_per_million !== undefined) {
    form.maxOutputUsdPerMillion = String(automatic.max_output_usd_per_million);
  }
  form.intelligenceMin = automatic.intelligence_min ?? '';
  form.intelligenceExpected = automatic.intelligence_expected ?? (['high', 'premium'].includes(form.intelligenceMin) ? form.intelligenceMin : 'mid');
  const capabilities = automatic.required_capabilities ?? [];
  form.requireText = capabilities.includes('text');
  form.requireImage = capabilities.includes('image');
  form.requireWebSearch = automatic.requires_web_search === true;
  form.excludeModelIds = (automatic.exclude_model_ids ?? []).join('\n');
  form.excludeProviderIds = (automatic.exclude_provider_ids ?? []).join('\n');
  form.excludeProfileIds = [...(automatic.exclude_profile_ids ?? [])];
  form.excludeClientIds = [...(automatic.exclude_client_ids ?? [])];
  if (task.timeout_ms !== undefined) form.timeoutMs = String(task.timeout_ms);
  return form;
}

/** Chinese display label for an imported task, distinguishing project tasks. */
export function routingTestTaskLabel(task: TaskRoutingTestTask): string {
  return task.project !== undefined && task.project.length > 0
    ? `${task.display_name}（项目 ${task.project}）`
    : task.display_name;
}

export function routingTestErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  return String(error);
}

/** Show at most this many fractional digits for a daemon-provided score. */
const FRACTION_DIGITS = 4;

function formatFactor(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: FRACTION_DIGITS }).format(value);
}

function formatTps(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

function formatRank(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return String(value);
}

function tableHeader(labels: string[]): HTMLElement {
  const row = document.createElement('tr');
  row.className = 'table-head';
  row.replaceChildren(...labels.map((label) => {
    const item = document.createElement('th');
    item.textContent = label;
    return item;
  }));
  return row;
}

function renderRow(row: TaskRoutingTestRow): HTMLElement {
  const cellValues: Array<[tag: 'strong' | 'span', text: string]> = [
    ['span', formatRank(row.rank)],
    ['span', row.provider_name],
    ['strong', row.model_name],
    ['span', formatTps(row.effective_tps)],
    ['span', formatFactor(row.price_score)],
    ['span', formatFactor(row.speed_score)],
    ['span', formatFactor(row.quota_score)],
    ['span', formatFactor(row.intelligence_score)],
    ['span', formatFactor(row.score)],
    ['span', row.reason ?? ''],
  ];
  const element = document.createElement('tr');
  element.className = `routing-test-row${row.rank === null ? ' is-rejected' : ''}`;
  element.replaceChildren(...cellValues.map(([tag, text]) => {
    const cell = document.createElement('td');
    cell.textContent = text;
    return cell;
  }));
  return element;
}

/**
 * Renders the flattened result as ONE compact semantic table. Rows keep backend
 * order; all values (including the factor contributions summing to the total)
 * are backend provided, and rejected rows carry a dash plus their concise
 * backend reason. Never emits client-computed strings.
 */
export function renderRoutingTestResult(result: TaskRoutingTestResult): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (result.rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'routing-test-empty';
    empty.textContent = '暂无可用模型';
    fragment.append(empty);
    return fragment;
  }
  const scroll = document.createElement('div');
  scroll.className = 'routing-test-scroll';
  const table = document.createElement('table');
  table.className = 'routing-test-table';
  table.append(tableHeader([
    '排名', '供应商', '模型', 'TPS', '价格分', '速度分', '额度分', '智能分', '总分', '原因',
  ]));
  for (const row of result.rows) table.append(renderRow(row));
  scroll.append(table);
  fragment.append(scroll);
  return fragment;
}

export interface RoutingTestControllerOptions {
  request(params: TaskRoutingTestParams): Promise<TaskRoutingTestResult>;
  importTasks(): Promise<{ tasks: TaskRoutingTestTask[] }>;
  runButton: HTMLButtonElement;
  importButton: HTMLButtonElement;
  taskPicker: HTMLSelectElement;
  importRow?: HTMLElement;
  status: HTMLElement;
  result: HTMLElement;
  /** Reads the current editable form state. */
  readForm(): RoutingTestFormState;
  /** Applies an imported task to the editable form. */
  applyTask(task: TaskRoutingTestTask): void;
}

/**
 * Owns the routing-test run lifecycle: lazily imports the task list on the
 * import button only, disables duplicate runs, handles late responses, and
 * invalidates stale results whenever the form changes or a newer import/test
 * response arrives. It never auto-fetches tasks/settings or auto-runs on entry.
 */
export class RoutingTestController {
  private busy = false;
  private runToken = 0;
  private importToken = 0;
  private importedTasks: TaskRoutingTestTask[] | null = null;
  private importing = false;

  constructor(private readonly options: RoutingTestControllerOptions) {}

  /** Clear a stale result the moment the form changes (never re-runs it). */
  onFormChanged(): void {
    this.runToken += 1;
    this.options.result.replaceChildren();
    if (this.busy) this.setBusy(false);
    this.setStatus('未运行', 'is-pending');
  }

  /**
   * Lazily fetches raw task definitions ONLY when invoked. The list is cached
   * for subsequent clicks; a late response from a superseded import is
   * discarded. Populates the picker with Chinese task labels.
   */
  async importTasks(): Promise<void> {
    if (this.importing) return;
    this.importing = true;
    this.importToken += 1;
    const token = this.importToken;
    this.options.importButton.disabled = true;
    try {
      const tasks = (await this.options.importTasks()).tasks;
      if (token !== this.importToken) return;
      this.importedTasks = tasks;
      this.populatePicker(tasks);
      if (this.options.importRow) this.options.importRow.hidden = false;
      this.setStatus(tasks.length === 0 ? '无可用任务' : '', 'is-connected');
    } catch (error) {
      if (token !== this.importToken) return;
      this.setStatus('导入失败', 'is-unavailable');
      const message = document.createElement('p');
      message.className = 'routing-test-empty is-error';
      message.textContent = `导入失败：${routingTestErrorMessage(error)}`;
      this.options.result.replaceChildren(message);
    } finally {
      if (token === this.importToken) {
        this.importing = false;
        this.options.importButton.disabled = false;
      }
    }
  }

  /** Copies the selected imported task's raw fields into the editable form. */
  selectImportedTask(): void {
    const tasks = this.importedTasks;
    if (tasks === null) return;
    const selected = tasks.find((task) => task.identity === this.options.taskPicker.value);
    if (selected === undefined) return;
    this.options.applyTask(selected);
    this.onFormChanged();
  }

  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.runToken += 1;
    const token = this.runToken;
    this.options.result.replaceChildren();
    this.setBusy(true);
    this.setStatus('测试中…', 'is-pending');
    try {
      const result = await this.options.request(serializeRoutingTestRequest(this.options.readForm()));
      // Late responses from an invalidated run are discarded.
      if (token !== this.runToken) return;
      this.setStatus(result.rows.length === 0 ? '无结果' : `已返回 ${result.rows.length} 行`, 'is-connected');
      this.options.result.replaceChildren(renderRoutingTestResult(result));
    } catch (error) {
      if (token !== this.runToken) return;
      this.setStatus('失败', 'is-unavailable');
      const message = document.createElement('p');
      message.className = 'routing-test-empty is-error';
      message.textContent = `测试失败：${routingTestErrorMessage(error)}`;
      this.options.result.replaceChildren(message);
    } finally {
      if (token === this.runToken) this.setBusy(false);
    }
  }

  private populatePicker(tasks: TaskRoutingTestTask[]): void {
    const picker = this.options.taskPicker;
    picker.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '选择 Task';
    picker.append(placeholder);
    for (const task of tasks) {
      const option = document.createElement('option');
      option.value = task.identity;
      option.textContent = routingTestTaskLabel(task);
      picker.append(option);
    }
    picker.value = '';
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.options.runButton.disabled = busy;
    this.options.runButton.textContent = busy ? '测试中…' : '测试';
  }

  private setStatus(label: string, className: string): void {
    this.options.status.textContent = label;
    this.options.status.className = `routing-test-status status-pill ${className}`;
  }
}

export type { TaskRoutingTestTask };
