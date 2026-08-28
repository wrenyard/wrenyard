import type {
  PetCompanionSettings,
  QuotaProviderSnapshot,
  QuotaSnapshot,
  SettingsSnapshot,
  ShellPage,
  StatsPeriod,
  StatsSnapshot,
  StatsWindowSnapshot,
  WrenyardShellApi,
} from '../shell-contract.js';
import { ConversationView } from './conversation.js';

declare global {
  interface Window {
    wrenyardShell: WrenyardShellApi;
  }
}

const workbenchNav = requireElement<HTMLButtonElement>('workbench-nav');
const statsNav = requireElement<HTMLButtonElement>('stats-nav');
const quotaNav = requireElement<HTMLButtonElement>('quota-nav');
const settingsNav = requireElement<HTMLButtonElement>('settings-nav');
const workbenchPage = requireElement<HTMLElement>('workbench-page');
const statsPage = requireElement<HTMLElement>('stats-page');
const quotaPage = requireElement<HTMLElement>('quota-page');
const settingsPage = requireElement<HTMLElement>('settings-page');
const refreshButton = requireElement<HTMLButtonElement>('refresh-button');
const refreshLabel = requireElement<HTMLElement>('refresh-label');
const statsRefreshButton = requireElement<HTMLButtonElement>('stats-refresh-button');
const statsRefreshLabel = requireElement<HTMLElement>('stats-refresh-label');
const quotaRefreshButton = requireElement<HTMLButtonElement>('quota-refresh-button');
const quotaRefreshLabel = requireElement<HTMLElement>('quota-refresh-label');
const petSaveButton = requireElement<HTMLButtonElement>('pet-save-button');
const petSaveNote = requireElement<HTMLElement>('pet-save-note');
const builtinOnly = requireElement<HTMLInputElement>('stats-builtin-only');
const workspaceSettingInput = requireElement<HTMLInputElement>('workspace-setting-input');
const workspaceSaveButton = requireElement<HTMLButtonElement>('workspace-save-button');
const workspaceSettingNote = requireElement<HTMLElement>('workspace-setting-note');

let petDraft: PetCompanionSettings | null = null;
let petDirty = false;
let currentPage: ShellPage = 'workbench';
let currentStats: StatsSnapshot | null = null;
let selectedPeriod: StatsPeriod = '24h';

function requireElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing shell element: ${id}`);
  return element as T;
}

function setText(id: string, value: string): void {
  requireElement(id).textContent = value;
}

function formatServiceDuration(value: number | undefined): string {
  if (value === undefined) return '已连接';
  const totalMinutes = Math.max(0, Math.floor(value / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `已连接 · 已运行 ${days} 天 ${hours} 小时`;
  if (hours > 0) return `已连接 · 已运行 ${hours} 小时 ${minutes} 分钟`;
  return `已连接 · 已运行 ${minutes} 分钟`;
}

function formatTaskDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`;
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 > 0 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function periodLabel(period: StatsPeriod): string {
  if (period === '24h') return '最近 24 小时';
  if (period === '7d') return '最近 7 天';
  return '最近 1 个月';
}

function renderSnapshot(snapshot: SettingsSnapshot): void {
  const connected = snapshot.service.status === 'connected';
  const serviceStatus = requireElement('service-status');
  serviceStatus.textContent = connected ? '已连接' : '不可用';
  serviceStatus.className = `status-pill ${connected ? 'is-connected' : 'is-unavailable'}`;
  setText('service-description', connected ? formatServiceDuration(snapshot.service.uptimeMs) : '未能连接本地 Wrenyard 服务');
  workspaceSettingInput.value = snapshot.service.workspace.path ?? '';
  const workspaceFromEnvironment = snapshot.service.workspace.source === 'environment';
  workspaceSettingInput.readOnly = workspaceFromEnvironment;
  workspaceSettingInput.setAttribute('aria-readonly', String(workspaceFromEnvironment));
  workspaceSaveButton.disabled = workspaceFromEnvironment;
  workspaceSaveButton.textContent = workspaceFromEnvironment ? '环境变量管理' : '保存并应用';
  workspaceSettingNote.textContent = workspaceFromEnvironment
    ? '由环境变量 WRENYARD_DESKTOP_WORKSPACE 提供；路径只读，如需修改请调整启动环境。'
    : snapshot.service.workspace.status === 'configured'
      ? `已绑定 · 配置写入 ${snapshot.service.workspace.configPath}`
      : snapshot.service.workspace.message ?? `尚未配置 · 将写入 ${snapshot.service.workspace.configPath}`;
  setText('endpoint-value', snapshot.service.endpoint);
  renderPet(snapshot);

  const modelList = requireElement('model-list');
  modelList.replaceChildren(...snapshot.models.map((model) => {
    const row = document.createElement('div');
    row.className = 'setting-row';
    const copy = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = model.label;
    const description = document.createElement('p');
    description.textContent = model.id;
    copy.append(title, description);
    const status = document.createElement('span');
    status.className = `status-pill ${model.configured ? 'is-configured' : 'is-missing'}`;
    status.textContent = model.configured ? '已配置' : '未配置';
    row.append(copy, status);
    return row;
  }));

  setText('wrenyard-version', snapshot.about.wrenyardVersion);
  setText('desktop-version', snapshot.about.desktopVersion);
  setText('dsh-version', snapshot.about.dshVersion);
}

function renderPet(snapshot: SettingsSnapshot): void {
  petDraft = structuredClone(snapshot.pet.settings);
  petDirty = false;
  petSaveButton.disabled = true;
  petSaveNote.textContent = '位置仍可直接拖动房屋保存。';

  const status = requireElement('pet-status');
  status.textContent = petStatusLabel(snapshot.pet.status);
  status.className = `status-pill ${snapshot.pet.status === 'running' ? 'is-connected' : snapshot.pet.status === 'failed' ? 'is-unavailable' : 'is-pending'}`;

  setChecked('pet-enabled', petDraft.enabled);
  const display = requireElement<HTMLSelectElement>('pet-display');
  display.replaceChildren(...snapshot.pet.displays.map((item) => {
    const option = document.createElement('option');
    option.value = String(item.id);
    option.textContent = `${item.label}${item.isPrimary ? '（主显示器）' : ''}`;
    return option;
  }));
  const fallbackDisplay = snapshot.pet.displays.find((item) => item.isPrimary)?.id ?? snapshot.pet.displays[0]?.id;
  if (petDraft.displayId !== undefined || fallbackDisplay !== undefined) {
    display.value = String(petDraft.displayId ?? fallbackDisplay);
  }
  display.disabled = snapshot.pet.displays.length === 0;

  setInputValue('pet-house-skin', petDraft.appearance.houseSkin);
  setInputValue('pet-scale', String(petDraft.scale));
  setInputValue('pet-bottom-offset', String(petDraft.bottomOffset));
  setInputValue('pet-bubble-seconds', String(petDraft.bubbleSeconds));
  setChecked('pet-show-house', petDraft.entities.house);
  setChecked('pet-show-workers', petDraft.entities.workers);
  setChecked('pet-show-taskgraphs', petDraft.entities.taskgraphs);
  renderProviders();
}

function petStatusLabel(status: SettingsSnapshot['pet']['status']): string {
  if (status === 'running') return '运行中';
  if (status === 'starting') return '启动中';
  if (status === 'stopping') return '停止中';
  if (status === 'failed') return '启动失败';
  return '已停止';
}

function setInputValue(id: string, value: string): void {
  requireElement<HTMLInputElement | HTMLSelectElement>(id).value = value;
}

function setChecked(id: string, checked: boolean): void {
  requireElement<HTMLInputElement>(id).checked = checked;
}

function markPetDirty(): void {
  petDirty = true;
  petSaveButton.disabled = false;
  petSaveNote.textContent = '修改尚未保存；保存后立即重新载入桌宠。';
}

function collectPetSettings(): PetCompanionSettings | null {
  if (!petDraft) return null;
  const displayValue = Number(requireElement<HTMLSelectElement>('pet-display').value);
  return {
    ...petDraft,
    enabled: requireElement<HTMLInputElement>('pet-enabled').checked,
    ...(Number.isInteger(displayValue) ? { displayId: displayValue } : {}),
    scale: Number(requireElement<HTMLInputElement>('pet-scale').value),
    bubbleSeconds: Number(requireElement<HTMLInputElement>('pet-bubble-seconds').value),
    bottomOffset: Number(requireElement<HTMLInputElement>('pet-bottom-offset').value),
    entities: {
      house: requireElement<HTMLInputElement>('pet-show-house').checked,
      workers: requireElement<HTMLInputElement>('pet-show-workers').checked,
      taskgraphs: requireElement<HTMLInputElement>('pet-show-taskgraphs').checked,
    },
    appearance: {
      houseSkin: requireElement<HTMLSelectElement>('pet-house-skin').value === 'mushroom' ? 'mushroom' : 'classic',
    },
    quota: { providers: petDraft.quota.providers.map((provider) => ({ ...provider })) },
  };
}

function renderProviders(): void {
  const providers = petDraft?.quota.providers ?? [];
  requireElement('pet-provider-list').replaceChildren(...providers.map((provider, index) => {
    const row = document.createElement('div');
    row.className = 'provider-row';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = provider.enabled;
    toggle.setAttribute('aria-label', `显示 ${provider.id}`);
    toggle.addEventListener('change', () => {
      if (!petDraft) return;
      petDraft.quota.providers[index].enabled = toggle.checked;
      markPetDirty();
    });
    const id = document.createElement('span');
    id.className = 'provider-id';
    id.textContent = provider.id;
    row.append(
      toggle,
      id,
      providerMoveButton('↑', index === 0, () => moveProvider(index, index - 1)),
      providerMoveButton('↓', index === providers.length - 1, () => moveProvider(index, index + 1)),
    );
    return row;
  }));
}

function providerMoveButton(label: string, disabled: boolean, move: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'provider-move';
  button.textContent = label;
  button.disabled = disabled;
  button.setAttribute('aria-label', label === '↑' ? '上移' : '下移');
  button.addEventListener('click', move);
  return button;
}

function moveProvider(from: number, to: number): void {
  if (!petDraft || to < 0 || to >= petDraft.quota.providers.length) return;
  const [provider] = petDraft.quota.providers.splice(from, 1);
  petDraft.quota.providers.splice(to, 0, provider);
  renderProviders();
  markPetDirty();
}

function renderStats(snapshot: StatsSnapshot): void {
  currentStats = snapshot;
  const available = snapshot.status === 'available' && snapshot.today !== null;
  const status = requireElement('stats-status');
  status.textContent = available ? (snapshot.source === 'summary' ? '本地台账' : '兼容数据') : '不可用';
  status.className = `status-pill ${available ? 'is-connected' : 'is-unavailable'}`;
  setText('stats-day-label', available && snapshot.today
    ? `${snapshot.today.dayKey} · ${snapshot.source === 'summary' ? 'SQLite 权威汇总' : '仅今日兼容投影'}`
    : '未能读取本地统计；任务运行不受影响。');
  renderDaily(snapshot);
  renderPeriod(snapshot);
}

function renderQuota(snapshot: QuotaSnapshot): void {
  const available = snapshot.status === 'available';
  const status = requireElement('quota-status');
  status.textContent = available ? '额度已同步' : '暂不可用';
  status.className = `status-pill ${available ? 'is-connected' : 'is-unavailable'}`;
  const updated = snapshot.refreshedAt === undefined
    ? '尚未完成刷新'
    : `更新于 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(snapshot.refreshedAt)}`;
  setText('quota-updated-at', snapshot.message ? `${updated} · ${snapshot.message}` : updated);

  const grid = requireElement('quota-provider-grid');
  if (snapshot.providers.length === 0) {
    grid.replaceChildren(emptyQuotaCard(available ? '没有启用的额度来源，可在设置中开启。' : '额度数据暂时不可用，请稍后刷新。'));
    return;
  }
  grid.replaceChildren(...snapshot.providers.map(quotaProviderCard));
}

function quotaProviderCard(provider: QuotaProviderSnapshot): HTMLElement {
  const card = document.createElement('article');
  card.className = `quota-provider-card quota-status-${provider.status}`;

  const header = document.createElement('header');
  const identity = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = provider.label;
  const id = document.createElement('code');
  id.textContent = provider.id;
  identity.append(title, id);
  const state = document.createElement('span');
  state.className = `quota-provider-state is-${provider.status}`;
  state.textContent = `${quotaStatusLabel(provider.status)}${provider.stale ? ' · 旧数据' : ''}`;
  header.append(identity, state);
  card.append(header);

  const body = document.createElement('div');
  body.className = 'quota-provider-body';
  for (const window of provider.windows) {
    const row = document.createElement('div');
    row.className = 'quota-window-row';
    const rowHeader = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = window.name;
    const percentage = document.createElement('span');
    percentage.textContent = `${Math.floor(window.remainingPct)}%`;
    rowHeader.append(name, percentage);
    const track = document.createElement('div');
    track.className = `quota-track${window.remainingPct < 20 ? ' is-low' : ''}`;
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', `${provider.label} ${window.name} 剩余`);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(window.remainingPct));
    const fill = document.createElement('i');
    fill.style.width = `${window.remainingPct}%`;
    track.append(fill);
    if (window.expectedRemainingPct !== null) {
      const marker = document.createElement('b');
      marker.style.left = `${window.expectedRemainingPct}%`;
      marker.title = `按当前时间进度建议剩余 ${Math.floor(window.expectedRemainingPct)}%`;
      track.append(marker);
    }
    row.append(rowHeader, track);
    body.append(row);
  }
  for (const balance of provider.balances) {
    const row = document.createElement('div');
    row.className = 'quota-balance-row';
    const name = document.createElement('span');
    name.textContent = balance.currency;
    const value = document.createElement('strong');
    value.textContent = balance.display;
    row.append(name, value);
    body.append(row);
  }
  if (provider.message || (provider.windows.length === 0 && provider.balances.length === 0)) {
    const note = document.createElement('p');
    note.className = 'quota-provider-message';
    note.textContent = provider.message ?? provider.displayLine ?? '暂无可展示的额度数据。';
    body.append(note);
  } else if (provider.displayLine) {
    const note = document.createElement('p');
    note.className = 'quota-provider-detail';
    note.textContent = provider.displayLine;
    body.append(note);
  }
  card.append(body);
  return card;
}

function quotaStatusLabel(status: QuotaProviderSnapshot['status']): string {
  if (status === 'ok') return '可用';
  if (status === 'pending') return '等待中';
  if (status === 'error') return '错误';
  return '不可用';
}

function emptyQuotaCard(message: string): HTMLElement {
  const empty = document.createElement('div');
  empty.className = 'quota-empty';
  const icon = document.createElement('span');
  icon.textContent = '◇';
  const copy = document.createElement('p');
  copy.textContent = message;
  empty.append(icon, copy);
  return empty;
}

function renderPeriod(snapshot: StatsSnapshot): void {
  const statsWindow = selectedWindow(snapshot);
  if (statsWindow && statsWindow.period !== selectedPeriod) selectedPeriod = statsWindow.period;
  syncPeriodButtons();

  const today = snapshot.today;
  const dispatch = statsWindow?.dispatchCount ?? today?.dispatchCount;
  const tokens = statsWindow?.totalTokens ?? today?.totalTokens;
  setText('stats-dispatch-count', dispatch === undefined ? '—' : formatCount(dispatch));
  setText('stats-total-tokens', tokens === undefined ? '—' : formatCompact(tokens));
  setText('stats-dispatch-note', statsWindow ? periodLabel(statsWindow.period) : '今日兼容数据');
  setText('stats-token-split', statsWindow
    ? `${periodLabel(statsWindow.period)}总量`
    : today ? `输入 ${formatCompact(today.inputTokens)} · 输出 ${formatCompact(today.outputTokens)}` : '输入 — · 输出 —');

  const outcomes = today?.outcomes;
  const completed = outcomes ? outcomes.done + outcomes.failed : 0;
  setText('stats-completion-rate', outcomes && completed > 0 ? `${Math.round(outcomes.done / completed * 100)}%` : '—');
  setText('stats-outcome-split', outcomes
    ? `完成 ${formatCount(outcomes.done)} · 失败 ${formatCount(outcomes.failed)} · 取消 ${formatCount(outcomes.cancelled)}`
    : '暂无权威结果数据');
  setText('stats-duration', statsWindow ? formatTaskDuration(statsWindow.totalDurationMs) : '—');
  setText('stats-duration-period', statsWindow ? periodLabel(statsWindow.period) : '需要新版 Wrenyard');
  setText('stats-period-range', statsWindow
    ? `${formatDateTime(statsWindow.startAt)} 至 ${formatDateTime(statsWindow.endAt)}`
    : '当前控制面仅提供今日总量；周期台账需要新版 Wrenyard。');

  renderProfiles(snapshot, statsWindow);
  renderTasks(statsWindow);
}

function selectedWindow(snapshot: StatsSnapshot): StatsWindowSnapshot | undefined {
  return snapshot.windows.find((item) => item.period === selectedPeriod) ?? snapshot.windows[0];
}

function renderDaily(snapshot: StatsSnapshot): void {
  const daily = snapshot.daily.slice(-31);
  const list = requireElement('stats-daily-list');
  if (daily.length === 0) {
    list.replaceChildren(emptyRow('暂无每日活动记录'));
    return;
  }
  const maxTokens = Math.max(1, ...daily.map((item) => item.totalTokens));
  list.replaceChildren(...daily.map((item) => {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = `heat-cell heat-${Math.min(4, Math.ceil(item.totalTokens / maxTokens * 4))}`;
    cell.setAttribute('role', 'listitem');
    cell.setAttribute('aria-label', `${item.dayKey}，${formatCount(item.dispatchCount)} 次调度，${formatCount(item.totalTokens)} Token`);
    cell.title = `${item.dayKey}\n${formatCount(item.dispatchCount)} 次调度 · ${formatCount(item.totalTokens)} Token`;
    const day = document.createElement('span');
    day.textContent = item.dayKey.slice(-2);
    const runs = document.createElement('small');
    runs.textContent = formatCompact(item.totalTokens);
    cell.append(day, runs);
    return cell;
  }));
}

function renderProfiles(snapshot: StatsSnapshot, statsWindow: StatsWindowSnapshot | undefined): void {
  const list = requireElement('stats-profile-list');
  const rows = statsWindow?.byProfile ?? snapshot.byProfile.map((item) => ({
    name: item.name,
    runCount: item.dispatchCount,
    totalTokens: item.totalTokens,
  }));
  if (rows.length === 0) {
    list.replaceChildren(emptyRow('暂无具名运行配置'));
    return;
  }
  list.replaceChildren(
    tableHeader(['配置', '运行', 'Token', '平均 TPS']),
    ...rows.slice(0, 12).map((row) => tableRow([
      row.name,
      formatCount(row.runCount),
      formatCompact(row.totalTokens),
      'averageTps' in row && typeof row.averageTps === 'number' ? row.averageTps.toFixed(2) : '—',
    ], 'profile-row')),
  );
}

function renderTasks(statsWindow: StatsWindowSnapshot | undefined): void {
  const list = requireElement('stats-task-list');
  if (!statsWindow) {
    list.replaceChildren(emptyRow('需要新版 Wrenyard 提供周期任务统计'));
    return;
  }
  const rows = builtinOnly.checked ? statsWindow.byBuiltinTask : statsWindow.byTask;
  const denominator = builtinOnly.checked ? statsWindow.builtinTotalDurationMs : statsWindow.totalDurationMs;
  if (rows.length === 0) {
    list.replaceChildren(emptyRow(builtinOnly.checked ? '暂无内置任务记录' : '暂无任务记录'));
    return;
  }
  list.replaceChildren(
    tableHeader(['Task', '来源', '运行', '平均耗时', '占比']),
    ...rows.slice(0, 12).map((row) => {
      const share = denominator > 0 ? row.durationMs / denominator * 100 : 0;
      return tableRow([
        row.name,
        sourceLabel(row.source),
        formatCount(row.runCount),
        formatTaskDuration(row.averageDurationMs),
        share > 0 && share < 1 ? '<1%' : `${Math.round(share)}%`,
      ], `task-row source-${row.source}`);
    }),
  );
}

function tableHeader(labels: string[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'table-row table-head';
  row.replaceChildren(...labels.map((label) => {
    const cell = document.createElement('span');
    cell.textContent = label;
    return cell;
  }));
  return row;
}

function tableRow(values: string[], className: string): HTMLElement {
  const row = document.createElement('div');
  row.className = `table-row ${className}`;
  row.replaceChildren(...values.map((value, index) => {
    const cell = document.createElement(index === 0 ? 'strong' : 'span');
    cell.textContent = value;
    cell.title = value;
    return cell;
  }));
  return row;
}

function sourceLabel(source: StatsWindowSnapshot['byTask'][number]['source']): string {
  if (source === 'builtin') return '内置';
  if (source === 'project') return '项目';
  return '未知';
}

function emptyRow(label: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'empty-row';
  row.textContent = label;
  return row;
}

function syncPeriodButtons(): void {
  const buttons = Array.from(requireElement('stats-period-switcher').querySelectorAll<HTMLButtonElement>('button[data-period]'));
  for (const button of buttons) {
    const selected = button.dataset.period === selectedPeriod;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-selected', String(selected));
  }
}

function renderPage(page: ShellPage): void {
  currentPage = page;
  document.documentElement.dataset.page = page;
  const pages: Array<[ShellPage, HTMLButtonElement, HTMLElement]> = [
    ['workbench', workbenchNav, workbenchPage],
    ['stats', statsNav, statsPage],
    ['quota', quotaNav, quotaPage],
    ['settings', settingsNav, settingsPage],
  ];
  for (const [candidate, nav, section] of pages) {
    const selected = candidate === page;
    nav.classList.toggle('is-selected', selected);
    section.hidden = !selected;
    if (selected) nav.setAttribute('aria-current', 'page');
    else nav.removeAttribute('aria-current');
  }
  const pageTitle = page === 'stats' ? '工房台账' : page === 'quota' ? '额度' : '设置';
  document.title = page === 'workbench' ? '啾啾工坊' : `${pageTitle} — 啾啾工坊`;
}

async function navigate(page: ShellPage): Promise<void> {
  renderPage(page);
  await window.wrenyardShell.navigate(page);
  if (page === 'stats') await refreshStats();
  if (page === 'quota') await refreshQuota(false);
  if (page === 'settings') renderSnapshot(await window.wrenyardShell.getSettings());
}

async function refreshStats(): Promise<void> {
  statsRefreshButton.disabled = true;
  statsRefreshLabel.textContent = '刷新中…';
  try {
    renderStats(await window.wrenyardShell.getStats());
  } finally {
    statsRefreshButton.disabled = false;
    statsRefreshLabel.textContent = '刷新';
  }
}

async function refreshQuota(forceRefresh: boolean): Promise<void> {
  quotaRefreshButton.disabled = true;
  quotaRefreshLabel.textContent = '刷新中…';
  try {
    renderQuota(await window.wrenyardShell.getQuota(forceRefresh));
  } finally {
    quotaRefreshButton.disabled = false;
    quotaRefreshLabel.textContent = '刷新';
  }
}

workbenchNav.addEventListener('click', () => void navigate('workbench'));
statsNav.addEventListener('click', () => void navigate('stats'));
quotaNav.addEventListener('click', () => void navigate('quota'));
settingsNav.addEventListener('click', () => void navigate('settings'));
refreshButton.addEventListener('click', () => {
  refreshButton.disabled = true;
  refreshLabel.textContent = '正在刷新…';
  void window.wrenyardShell.getSettings().then(renderSnapshot).finally(() => {
    refreshButton.disabled = false;
    refreshLabel.textContent = '刷新状态';
  });
});
statsRefreshButton.addEventListener('click', () => void refreshStats());
quotaRefreshButton.addEventListener('click', () => void refreshQuota(true));
builtinOnly.addEventListener('change', () => {
  if (currentStats) renderPeriod(currentStats);
});

const periodSwitcher = requireElement('stats-period-switcher');
periodSwitcher.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || !target.dataset.period) return;
  selectedPeriod = target.dataset.period as StatsPeriod;
  if (currentStats) renderPeriod(currentStats);
});
periodSwitcher.addEventListener('keydown', (event) => {
  if (!(event instanceof KeyboardEvent) || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
  const periods: StatsPeriod[] = ['24h', '7d', '1mo'];
  const delta = event.key === 'ArrowRight' ? 1 : -1;
  selectedPeriod = periods[(periods.indexOf(selectedPeriod) + delta + periods.length) % periods.length];
  syncPeriodButtons();
  periodSwitcher.querySelector<HTMLButtonElement>(`button[data-period="${selectedPeriod}"]`)?.focus();
  if (currentStats) renderPeriod(currentStats);
  event.preventDefault();
});

for (const id of [
  'pet-enabled', 'pet-display', 'pet-house-skin', 'pet-scale', 'pet-bottom-offset',
  'pet-bubble-seconds', 'pet-show-house', 'pet-show-workers', 'pet-show-taskgraphs',
]) requireElement(id).addEventListener('change', markPetDirty);

petSaveButton.addEventListener('click', () => {
  const settings = collectPetSettings();
  if (!settings || !petDirty) return;
  petSaveButton.disabled = true;
  petSaveButton.textContent = '正在应用…';
  void window.wrenyardShell.savePetSettings(settings)
    .then(renderSnapshot)
    .catch(() => {
      petSaveNote.textContent = '应用失败，请检查桌宠资源与本地权限。';
      petSaveButton.disabled = false;
    })
    .finally(() => { petSaveButton.textContent = '保存并应用'; });
});

workspaceSaveButton.addEventListener('click', () => {
  workspaceSaveButton.disabled = true;
  workspaceSaveButton.textContent = '正在保存…';
  workspaceSettingNote.textContent = '';
  void window.wrenyardShell.saveWorkspace(workspaceSettingInput.value)
    .then(async () => {
      workspaceSaveButton.textContent = '已应用';
      workspaceSettingNote.textContent = 'Workspace 已保存，会话后端已切换，无需重启 App。';
      renderSnapshot(await window.wrenyardShell.getSettings());
    })
    .catch((error: unknown) => {
      workspaceSettingNote.textContent = error instanceof Error ? error.message : String(error);
      workspaceSaveButton.disabled = false;
      workspaceSaveButton.textContent = '保存并应用';
    });
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && currentPage !== 'workbench') {
    event.preventDefault();
    void navigate('workbench');
  }
});

window.wrenyardShell.onViewChanged((page) => {
  const changed = page !== currentPage;
  renderPage(page);
  if (!changed) return;
  if (page === 'stats') void refreshStats();
  if (page === 'quota') void refreshQuota(false);
  if (page === 'settings') void window.wrenyardShell.getSettings().then(renderSnapshot);
});
window.wrenyardShell.onQuotaChanged(() => {
  if (currentPage === 'quota') void refreshQuota(false);
});
void window.wrenyardShell.getSettings().then(renderSnapshot);
const conversationView = new ConversationView(window.wrenyardShell, () => void navigate('settings'));
conversationView.start();
