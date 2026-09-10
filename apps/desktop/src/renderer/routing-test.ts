import type {
  TaskRoutingTestCandidateRow,
  TaskRoutingTestExclusion,
  TaskRoutingTestResult,
  TaskSettingsAutomaticDispatch,
} from '../shell-contract.js';

/**
 * Read-only routing-test renderer helpers/controller.
 *
 * This module only displays the daemon-owned routing result and wires the
 * single preset selector + run button. It never computes routing, ranking, or
 * scores: every number shown (including the weighted total) comes verbatim
 * from the backend `task.settings.routingTest` response.
 */

/** The only presets the routing test exposes; each maps to a real task id. */
export interface RoutingTestPreset {
  taskId: string;
  label: string;
}

export const ROUTING_TEST_PRESETS: readonly RoutingTestPreset[] = [
  { taskId: 'edit', label: '编辑文件' },
  { taskId: 'code-review', label: '变更审查' },
  { taskId: 'oracle', label: '分析顾问' },
  { taskId: 'librarian', label: '资料研究' },
];

export function routingTestPresetLabel(taskId: string): string {
  return ROUTING_TEST_PRESETS.find((preset) => preset.taskId === taskId)?.label ?? taskId;
}

/** Show at most this many fractional digits for a daemon-provided score/factor. */
const FRACTION_DIGITS = 4;

function formatScore(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: FRACTION_DIGITS }).format(value);
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `$${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: FRACTION_DIGITS }).format(value)}`;
}

function formatTps(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)} TPS`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

const QUOTA_TIER_LABELS: Record<TaskRoutingTestCandidateRow['quota_tier'], string> = {
  healthy: '健康',
  unknown: '未知',
  strained: '紧张',
};

const SUPPLY_CLASS_LABELS: Record<TaskRoutingTestCandidateRow['supply_class'], string> = {
  confirmed_free: '已确认免费',
  standard: '标准',
};

const EXCLUSION_STAGE_LABELS: Record<TaskRoutingTestExclusion['stage'], string> = {
  quota_blocked: '额度阻断',
  readiness_rejected: '就绪探测拒绝',
  not_scorable: '无可用证据',
  catalog_excluded: '目录排除',
};

export function exclusionStageLabel(stage: string): string {
  return EXCLUSION_STAGE_LABELS[stage as TaskRoutingTestExclusion['stage']] ?? stage;
}

/** Weighted contribution of a candidate factor against its actual response weight. */
export interface RoutingTestFactorRow {
  key: 'price' | 'speed' | 'quota' | 'intelligence';
  label: string;
  factor: number;
  weight: number;
  contribution: number;
}

/**
 * Pairs the four normalized candidate factors with the actual ranking weights
 * the daemon reported, exposing `factor × actual weight` so the total is
 * inspectable. This is display-only: the total score itself is never derived
 * here.
 */
export function routingTestFactorRows(
  candidate: TaskRoutingTestCandidateRow,
  result: TaskRoutingTestResult,
): RoutingTestFactorRow[] {
  const weights = result.ranking_weights;
  return ([
    { key: 'price', label: '价格', factor: candidate.price_factor, weight: weights.price },
    { key: 'speed', label: '速度', factor: candidate.speed_factor, weight: weights.speed },
    { key: 'quota', label: '额度', factor: candidate.quota_factor, weight: weights.quota },
    { key: 'intelligence', label: '智能', factor: candidate.intelligence_factor, weight: weights.intelligence },
  ] satisfies Omit<RoutingTestFactorRow, 'contribution'>[]).map((row) => ({ ...row, contribution: row.factor * row.weight }));
}

/** Compact human-readable summary of the effective automatic dispatch requirements. */
export function formatEffectiveRequirements(requirements: TaskSettingsAutomaticDispatch): string {
  const parts: string[] = [];
  if (requirements.expected_tps !== undefined) parts.push(`期望 ≥ ${formatTps(requirements.expected_tps)}`);
  if (requirements.minimum_tps !== undefined) parts.push(`最低 ≥ ${formatTps(requirements.minimum_tps)}`);
  if (requirements.intelligence_min !== undefined) parts.push(`智能最低 ${requirements.intelligence_min}`);
  if (requirements.intelligence_expected !== undefined) parts.push(`推荐智能 ${requirements.intelligence_expected}`);
  if (requirements.max_output_usd_per_million !== undefined) {
    parts.push(`参考单价上限 ${formatUsd(requirements.max_output_usd_per_million)}/M`);
  }
  if (requirements.required_capabilities !== undefined && requirements.required_capabilities.length > 0) {
    parts.push(`能力 ${requirements.required_capabilities.join('、')}`);
  }
  if (requirements.requires_web_search !== undefined) {
    parts.push(requirements.requires_web_search ? '需要联网搜索' : '无需联网搜索');
  }
  const exclusions: string[] = [];
  if (requirements.exclude_model_ids?.length) exclusions.push(`模型 ${requirements.exclude_model_ids.length} 个`);
  if (requirements.exclude_profile_ids?.length) exclusions.push(`档案 ${requirements.exclude_profile_ids.length} 个`);
  if (requirements.exclude_client_ids?.length) exclusions.push(`客户端 ${requirements.exclude_client_ids.length} 个`);
  if (requirements.exclude_provider_ids?.length) exclusions.push(`提供方 ${requirements.exclude_provider_ids.length} 个`);
  if (exclusions.length > 0) parts.push(`排除 ${exclusions.join('、')}`);
  return parts.length > 0 ? parts.join(' · ') : '无额外自动派发约束';
}

export function routingTestErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  return String(error);
}

function cell(tag: 'strong' | 'span', text: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = text;
  element.title = text;
  return element;
}

function tableHeader(labels: string[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'table-row table-head';
  row.replaceChildren(...labels.map((label) => {
    const item = document.createElement('span');
    item.textContent = label;
    return item;
  }));
  return row;
}

function renderCandidateDetail(candidate: TaskRoutingTestCandidateRow, result: TaskRoutingTestResult): HTMLElement {
  const details = document.createElement('details');
  details.className = 'routing-test-detail';
  const summary = document.createElement('summary');
  summary.textContent = '评分计算';
  details.append(summary);

  const table = document.createElement('div');
  table.className = 'routing-test-factor-table';
  table.append(tableHeader(['因子', '归一化因子', '权重', '加权贡献']));
  for (const row of routingTestFactorRows(candidate, result)) {
    const factorRow = document.createElement('div');
    factorRow.className = 'table-row routing-test-factor-row';
    factorRow.append(
      cell('strong', row.label),
      cell('span', formatScore(row.factor)),
      cell('span', formatScore(row.weight)),
      cell('span', formatScore(row.contribution)),
    );
    table.append(factorRow);
  }
  details.append(table);

  const total = document.createElement('p');
  total.className = 'routing-test-detail-total';
  total.textContent = `加权总分（后台计算）：${formatScore(candidate.score)}`;
  details.append(total);

  const notes = candidate.notes.filter((note) => note.length > 0);
  if (notes.length > 0) {
    const list = document.createElement('ul');
    list.className = 'routing-test-notes';
    for (const note of notes) {
      const item = document.createElement('li');
      item.textContent = note;
      list.append(item);
    }
    details.append(list);
  }
  return details;
}

function renderCandidate(candidate: TaskRoutingTestCandidateRow, result: TaskRoutingTestResult): HTMLElement {
  const row = document.createElement('div');
  row.className = `table-row routing-test-row rank-${candidate.rank}`;
  row.append(
    cell('strong', `#${candidate.rank} ${candidate.exact_runtime}`),
    cell('span', formatScore(candidate.score)),
    cell('span', formatScore(candidate.intelligence_shortfall)),
    cell('span', formatUsd(candidate.reference_output_usd_per_million)),
    cell('span', formatUsd(candidate.routing_output_usd_per_million)),
    cell('span', formatTps(candidate.effective_tps)),
    cell('span', QUOTA_TIER_LABELS[candidate.quota_tier]),
    cell('span', SUPPLY_CLASS_LABELS[candidate.supply_class]),
  );
  row.append(renderCandidateDetail(candidate, result));
  return row;
}

function renderSelection(container: DocumentFragment | HTMLElement, result: TaskRoutingTestResult): void {
  const section = document.createElement('section');
  section.className = 'routing-test-selection';
  const heading = document.createElement('h3');
  heading.textContent = '推荐运行配置';
  section.append(heading);

  if (result.selection) {
    const exact = document.createElement('p');
    exact.className = 'routing-test-selection-runtime';
    exact.textContent = result.selection.exact_runtime;
    const reason = document.createElement('p');
    reason.className = 'routing-test-selection-reason';
    reason.textContent = result.selection.reason;
    section.append(exact, reason);
    const resolved = result.selection.resolved;
    if (resolved) {
      const line = document.createElement('p');
      line.className = 'routing-test-selection-resolved';
      const provider = resolved.provider_display_name ?? resolved.provider;
      const model = resolved.model_display_name ?? resolved.model;
      line.textContent = `解析：${provider} · ${model} · ${resolved.client}`;
      section.append(line);
    }
  } else {
    const none = document.createElement('p');
    none.className = 'routing-test-selection-reason';
    none.textContent = result.failure
      ? `未选出运行配置：${result.failure.message}`
      : '未选出运行配置：没有满足约束的候选。';
    section.append(none);
  }
  container.append(section);
}

function renderStages(container: DocumentFragment | HTMLElement, result: TaskRoutingTestResult): void {
  const stages = result.stages;
  const line = document.createElement('p');
  line.className = 'routing-test-stages';
  line.textContent = [
    `静态符合 ${stages.eligible}`,
    `额度阻断 ${stages.quota_blocked}`,
    `就绪拒绝 ${stages.readiness_rejected}`,
    `合并去重 ${stages.collapsed}`,
    `有效计分 ${stages.scored}`,
    `进入排序 ${stages.ranked}`,
    `排除 ${stages.excluded}`,
  ].join(' · ');
  container.append(line);
}

function renderExclusions(container: DocumentFragment | HTMLElement, result: TaskRoutingTestResult): void {
  const section = document.createElement('section');
  section.className = 'routing-test-exclusions';
  const heading = document.createElement('h3');
  heading.textContent = '记录到的排除项';
  section.append(heading);

  if (result.static_eligibility) {
    const summary = document.createElement('p');
    summary.className = 'routing-test-eligibility';
    summary.textContent = `静态资格：${result.static_eligibility.message}（符合候选 ${result.static_eligibility.eligible_candidate_count}）`;
    section.append(summary);
  }

  if (result.exclusions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'routing-test-exclusions-empty';
    empty.textContent = '没有记录到被排除的候选。';
    section.append(empty);
    container.append(section);
    return;
  }

  const list = document.createElement('div');
  list.className = 'routing-test-exclusion-list';
  for (const exclusion of result.exclusions) {
    const row = document.createElement('div');
    row.className = 'routing-test-exclusion-row';
    row.append(
      cell('strong', exclusion.exact_runtime),
      cell('span', exclusionStageLabel(exclusion.stage)),
    );
    const reason = document.createElement('span');
    reason.className = 'routing-test-exclusion-reason';
    reason.textContent = exclusion.detail ? `${exclusion.code} · ${exclusion.detail}` : exclusion.code;
    row.append(reason);
    list.append(row);
  }
  section.append(list);
  container.append(section);
}

/**
 * Renders a routing-test result using textContent-only DOM output. Pre-scored
 * candidates are shown exactly as returned; skipped or unknown evidence appears
 * only under the exclusion/eligibility sections, never with a fabricated score.
 */
export function renderRoutingTestResult(result: TaskRoutingTestResult): DocumentFragment {
  const fragment = document.createDocumentFragment();

  const meta = document.createElement('p');
  meta.className = 'routing-test-meta';
  meta.textContent = `任务 ${routingTestPresetLabel(result.task_id)} · 检查时间 ${formatTimestamp(result.checked_at)} · 供应配置变化后请重新测试`;
  fragment.append(meta);

  const requirements = document.createElement('p');
  requirements.className = 'routing-test-requirements';
  requirements.textContent = `有效需求：${formatEffectiveRequirements(result.effective_requirements)}`;
  fragment.append(requirements);
  const cap = document.createElement('p');
  cap.className = 'routing-test-requirements';
  cap.textContent = result.effective_output_cap_usd_per_million === null
    ? '实际输出单价上限：尚未进入价格评分阶段'
    : `实际输出单价上限：${formatUsd(result.effective_output_cap_usd_per_million)} / 百万 Token（综合任务与全局设置）`;
  fragment.append(cap);

  if (result.ordering.length > 0) {
    const ordering = document.createElement('p');
    ordering.className = 'routing-test-ordering';
    ordering.textContent = `排序规则：先按建议智能差距从小到大，再按加权总分从高到低。`;
    fragment.append(ordering);
  }

  renderSelection(fragment, result);
  renderStages(fragment, result);

  const heading = document.createElement('h3');
  heading.textContent = `候选排序（${result.candidates.length}）`;
  fragment.append(heading);

  if (result.candidates.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'routing-test-empty';
    empty.textContent = '本次没有可排序的候选。';
    fragment.append(empty);
  } else {
    const scroll = document.createElement('div');
    scroll.className = 'routing-test-scroll';
    const table = document.createElement('div');
    table.className = 'routing-test-table';
    table.append(tableHeader([
      '运行配置', '总分', '智能缺口', '参考输出单价', '路由输出单价', '有效 TPS', '额度', '供应',
    ]));
    for (const candidate of result.candidates) table.append(renderCandidate(candidate, result));
    scroll.append(table);
    fragment.append(scroll);
  }

  renderExclusions(fragment, result);
  return fragment;
}

export interface RoutingTestControllerOptions {
  request(taskId: string): Promise<TaskRoutingTestResult>;
  presetSelect: HTMLSelectElement;
  runButton: HTMLButtonElement;
  status: HTMLElement;
  result: HTMLElement;
}

/**
 * Owns the routing-test run lifecycle: disable duplicate runs, handle late
 * responses, invalidate a stale result whenever the preset changes, and never
 * automatically invoke a model or persist configuration.
 */
export class RoutingTestController {
  private busy = false;
  private runToken = 0;

  constructor(private readonly options: RoutingTestControllerOptions) {}

  /** Clear a stale result the moment the preset changes (never re-runs it). */
  onPresetChanged(presets: readonly RoutingTestPreset[]): void {
    this.runToken += 1;
    this.options.result.replaceChildren();
    if (this.busy) this.setBusy(false);
    const known = presets.some((preset) => preset.taskId === this.options.presetSelect.value);
    this.setStatus(known ? '未运行' : '预设无效', 'is-pending');
  }

  async run(): Promise<void> {
    if (this.busy) return;
    const taskId = this.options.presetSelect.value;
    if (taskId.length === 0) {
      this.setStatus('请选择预设', 'is-unavailable');
      return;
    }
    this.busy = true;
    this.runToken += 1;
    const token = this.runToken;
    this.options.result.replaceChildren();
    this.setBusy(true);
    this.setStatus('测试中…', 'is-pending');
    try {
      const result = await this.options.request(taskId);
      // Late responses from an invalidated run are discarded.
      if (token !== this.runToken) return;
      if (result.candidates.length === 0) {
        this.setStatus('无候选', 'is-preview');
      } else {
        this.setStatus(`已排序 ${result.candidates.length}`, 'is-connected');
      }
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

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.options.runButton.disabled = busy;
    this.options.runButton.textContent = busy ? '测试中…' : '测试路由';
  }

  private setStatus(label: string, className: string): void {
    this.options.status.textContent = label;
    this.options.status.className = `routing-test-status status-pill ${className}`;
  }
}
