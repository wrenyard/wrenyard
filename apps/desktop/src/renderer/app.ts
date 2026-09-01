import type {
  PetCompanionSettings,
  ProviderCatalogSnapshot,
  QuotaProviderSnapshot,
  QuotaSnapshot,
  ServiceSnapshot,
  SettingsSnapshot,
  ShellPage,
  StatsPeriod,
  StatsSnapshot,
  StatsWindowSnapshot,
  UpdateChannel,
  UpdateSnapshot,
  WrenyardShellApi,
} from '../shell-contract.js';
import { daemonStatusPresentation } from '../daemon-status.js';
import { reorderProviders, swapProviders } from '../provider-order.js';
import { ConversationView } from './conversation.js';
import { buildActivityHeatmap } from './activity-heatmap.js';
import { formatBuildTime, formatCompactTokenCount, formatTaskDuration } from './format.js';

declare global {
  interface Window {
    wrenyardShell: WrenyardShellApi;
  }
}

document.documentElement.dataset.platform = window.wrenyardShell.platform;

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
const providerDialog = requireElement<HTMLElement>('provider-dialog');
const providerDialogTitle = requireElement<HTMLElement>('provider-dialog-title');
const providerDialogName = requireElement<HTMLElement>('provider-dialog-name');
const providerDialogId = requireElement<HTMLElement>('provider-dialog-id');
const providerDialogGuidance = requireElement<HTMLElement>('provider-dialog-guidance');
const providerKeyLabel = requireElement<HTMLLabelElement>('provider-key-label');
const providerKeyInput = requireElement<HTMLInputElement>('provider-key-input');
const providerDialogError = requireElement<HTMLElement>('provider-dialog-error');
const providerDialogCancel = requireElement<HTMLButtonElement>('provider-dialog-cancel');
const providerDialogSave = requireElement<HTMLButtonElement>('provider-dialog-save');
const updateActionButton = requireElement<HTMLButtonElement>('update-action-button');
const updateChannelSwitcher = requireElement<HTMLElement>('update-channel-switcher');
const statsHeatTooltip = requireElement<HTMLElement>('stats-heat-tooltip');

let petDraft: PetCompanionSettings | null = null;
let petDirty = false;
let dialogProvider: ProviderCatalogSnapshot | null = null;
let currentPage: ShellPage = 'workbench';
let currentStats: StatsSnapshot | null = null;
let currentQuota: QuotaSnapshot | null = null;
let selectedPeriod: StatsPeriod = '24h';
let providerOrderSaving = false;
let currentUpdate: UpdateSnapshot | null = null;
let updateActionBusy = false;

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

function formatDaemonStartedAt(value: number | undefined): string {
  if (value === undefined) return '启动时间暂不可用';
  return `启动时间 ${new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value)}`;
}

function renderDaemonStatus(service: Pick<ServiceSnapshot, 'status' | 'uptimeMs'>): void {
  const presentation = daemonStatusPresentation(service);
  const status = requireElement('conversation-daemon-status');
  const startedAt = presentation.status === 'connected'
    ? formatDaemonStartedAt(presentation.startedAt)
    : '启动时间不可用';
  status.className = `conversation-daemon-status is-${presentation.status}`;
  status.setAttribute('aria-label', `${presentation.label}，${startedAt}`);
  setText('conversation-daemon-label', presentation.label);
  setText('conversation-daemon-started-at', startedAt);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
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
  renderDaemonStatus(snapshot.service);
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
  renderUpdate(snapshot.update);

  setText('wrenyard-version', snapshot.about.wrenyardVersion);
  setText('desktop-version', snapshot.about.desktopVersion);
  setText('desktop-build-time', formatBuildTime(snapshot.about.buildTime));
  setText('dsh-version', snapshot.about.dshVersion);
}

function formatUpdateCheckTime(checkedAt: number | undefined): string {
  if (checkedAt === undefined) return '启动后会在后台自动检查';
  return `上次检查 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(checkedAt)}`;
}

function renderUpdate(snapshot: UpdateSnapshot): void {
  currentUpdate = snapshot;
  setText('update-current-version', `v${snapshot.currentVersion}`);
  setText('update-checked-at', formatUpdateCheckTime(snapshot.checkedAt));
  setText('update-channel-note', snapshot.channel === 'dev'
    ? '开发版更新更频繁，包含尚在打磨的新功能，稳定性较低。'
    : '正式版只接收正式发布的版本，更新节奏更稳定。');

  const channelLocked = snapshot.state === 'checking'
    || snapshot.state === 'preparing'
    || snapshot.state === 'restart-required';
  for (const button of Array.from(updateChannelSwitcher.querySelectorAll<HTMLButtonElement>('button[data-update-channel]'))) {
    const selected = button.dataset.updateChannel === snapshot.channel;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-selected', String(selected));
    button.disabled = channelLocked || updateActionBusy;
  }

  const status = requireElement('update-status');
  let statusLabel = '尚未检查';
  let statusClass = 'is-pending';
  let description = snapshot.message ?? '尚未检查更新。';
  let action = '检查更新';
  let primary = false;
  let disabled = updateActionBusy;

  if (snapshot.state === 'checking') {
    statusLabel = '检查中';
    description = '正在检查更新…';
    action = '正在检查…';
    disabled = true;
  } else if (snapshot.state === 'up-to-date') {
    statusLabel = '已是最新';
    statusClass = 'is-connected';
    description = snapshot.message ?? '当前已是最新版本。';
  } else if (snapshot.state === 'stable-unavailable') {
    statusLabel = '等待正式版';
    description = '正式版尚未发布，首个正式版上线时会在这里提示你。';
  } else if (snapshot.state === 'available') {
    statusLabel = '有新版本';
    statusClass = 'is-preview';
    description = `发现新版本 v${snapshot.availableVersion ?? '—'}（当前 v${snapshot.currentVersion}），将一次升级整个啾啾工坊套件。`;
    action = snapshot.installSupported ? '安装更新' : '暂不支持应用内安装';
    primary = snapshot.installSupported;
    disabled ||= !snapshot.installSupported;
  } else if (snapshot.state === 'preparing') {
    statusLabel = '准备中';
    description = snapshot.message ?? '正在下载并校验更新…';
    action = '正在准备…';
    disabled = true;
  } else if (snapshot.state === 'restart-required') {
    statusLabel = '更新就绪';
    statusClass = 'is-connected';
    description = snapshot.message ?? '更新已就绪，重启啾啾工坊后完成安装。';
    action = '重启并安装';
    primary = true;
  } else if (snapshot.state === 'install-blocked') {
    statusLabel = '等待任务结束';
    statusClass = 'is-preview';
    description = snapshot.message ?? '当前仍有任务运行，请完成或停止后再安装更新。';
    action = '重试安装';
    primary = true;
  } else if (snapshot.state === 'check-failed') {
    statusLabel = '暂时不可用';
    statusClass = 'is-unavailable';
    description = snapshot.message ?? '暂时无法检查更新，请检查网络连接后重试。';
    action = '重试';
  } else if (snapshot.state === 'install-failed') {
    statusLabel = '更新未完成';
    statusClass = 'is-unavailable';
    description = snapshot.message ?? '更新未完成，当前版本未受影响。';
    action = '重试安装';
    primary = true;
  }

  status.textContent = statusLabel;
  status.className = `status-pill ${statusClass}`;
  setText('update-description', description);
  updateActionButton.textContent = action;
  updateActionButton.className = primary ? 'primary-button' : 'secondary-button';
  updateActionButton.disabled = disabled;
}

async function runUpdateAction(): Promise<void> {
  if (!currentUpdate || updateActionBusy) return;
  updateActionBusy = true;
  renderUpdate(currentUpdate);
  try {
    if (currentUpdate.state === 'restart-required') {
      await window.wrenyardShell.restartUpdate();
      return;
    }
    const prepareStates: UpdateSnapshot['state'][] = ['available', 'install-blocked', 'install-failed'];
    renderUpdate(prepareStates.includes(currentUpdate.state)
      ? await window.wrenyardShell.prepareUpdate()
      : await window.wrenyardShell.checkUpdate());
  } finally {
    updateActionBusy = false;
    if (currentUpdate) renderUpdate(currentUpdate);
  }
}

async function selectUpdateChannel(channel: UpdateChannel): Promise<void> {
  if (!currentUpdate || currentUpdate.channel === channel || updateActionBusy) return;
  updateActionBusy = true;
  renderUpdate(currentUpdate);
  try {
    renderUpdate(await window.wrenyardShell.setUpdateChannel(channel));
  } finally {
    updateActionBusy = false;
    if (currentUpdate) renderUpdate(currentUpdate);
  }
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

function renderStats(snapshot: StatsSnapshot): void {
  currentStats = snapshot;
  const available = snapshot.status === 'available' && snapshot.today !== null;
  const status = requireElement('stats-status');
  status.textContent = available ? (snapshot.source === 'summary' ? '本地台账' : '兼容数据') : '不可用';
  status.className = `status-pill ${available ? 'is-connected' : 'is-unavailable'}`;
  renderDaily(snapshot);
  renderPeriod(snapshot);
}

function renderQuota(snapshot: QuotaSnapshot): void {
  currentQuota = snapshot;
  const available = snapshot.status === 'available';
  const status = requireElement('quota-status');
  status.textContent = available ? '模型供应已同步' : '暂不可用';
  status.className = `status-pill ${available ? 'is-connected' : 'is-unavailable'}`;
  const updated = snapshot.refreshedAt === undefined
    ? '尚未完成刷新'
    : `更新于 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(snapshot.refreshedAt)}`;
  setText('quota-updated-at', snapshot.message ? `${updated} · ${snapshot.message}` : updated);

  const list = requireElement('quota-provider-grid');
  const catalog = snapshot.catalog ?? [];
  if (catalog.length === 0) {
    list.replaceChildren(emptyQuotaCard(available ? '未发现受支持的 Provider。' : 'Provider 数据暂时不可用，请稍后刷新。'));
    return;
  }
  list.replaceChildren(...catalog.map((entry, index) => quotaProviderRow(entry, index, catalog)));
}

function quotaProviderRow(
  entry: ProviderCatalogSnapshot,
  index: number,
  catalog: ProviderCatalogSnapshot[],
): HTMLElement {
  const row = document.createElement('article');
  row.className = `provider-directory-row${entry.configured ? '' : ' is-unconfigured'}`;

  const header = document.createElement('div');
  header.className = 'provider-directory-header';
  const identity = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = entry.label ?? entry.id;
  const id = document.createElement('code');
  id.textContent = entry.id;
  const description = document.createElement('p');
  description.textContent = entry.description;
  identity.append(title, id, description);
  const state = document.createElement('span');
  state.className = `provider-directory-state ${entry.configured ? 'is-ok' : 'is-unavailable'}`;
  state.textContent = entry.quota?.code === 'configuration_missing'
    ? '未配置'
    : entry.quota?.code === 'authentication_required'
      ? '未登录'
      : entry.configured
        ? entry.authMode === 'none' ? '无需配置' : '已配置'
        : entry.authMode === 'native' ? '未登录' : '未激活';
  const meta = document.createElement('div');
  meta.className = 'provider-directory-header-meta';
  const orderButtons = entry.configured ? quotaProviderOrderButtons(entry, index, catalog) : undefined;
  meta.append(state);
  if (orderButtons) meta.append(orderButtons);
  header.append(identity, meta);

  const quota = document.createElement('div');
  quota.className = 'provider-directory-quota';
  appendQuotaContent(quota, entry);

  const action = providerRowAction(entry);

  row.append(header, quota, action);
  return row;
}

function quotaProviderOrderButtons(
  entry: ProviderCatalogSnapshot,
  index: number,
  catalog: ProviderCatalogSnapshot[],
): HTMLElement {
  const controls = document.createElement('span');
  controls.className = 'provider-directory-order';
  const previous = catalog[index - 1];
  const next = catalog[index + 1];
  controls.append(
    providerMoveButton('↑', providerOrderSaving || !previous || previous.configured !== entry.configured, () => {
      if (previous) void saveQuotaProviderMove(entry.id, previous.id, catalog);
    }),
    providerMoveButton('↓', providerOrderSaving || !next || next.configured !== entry.configured, () => {
      if (next) void saveQuotaProviderMove(entry.id, next.id, catalog);
    }),
  );
  return controls;
}

async function saveQuotaProviderMove(
  providerId: string,
  neighborId: string,
  catalog: ProviderCatalogSnapshot[],
): Promise<void> {
  if (!currentQuota || providerOrderSaving) return;
  providerOrderSaving = true;
  const completeOrder = reorderProviders(currentQuota.providerOrder, catalog.map((entry) => entry.id));
  const nextOrder = swapProviders(completeOrder, providerId, neighborId);
  let failure = '';
  renderQuota(currentQuota);
  try {
    renderQuota(await window.wrenyardShell.saveProviderOrder(nextOrder.map((entry) => entry.id)));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    providerOrderSaving = false;
    if (currentQuota) renderQuota(currentQuota);
  }
  if (failure) setText('quota-updated-at', `顺序保存失败 · ${failure}`);
}

function appendQuotaContent(container: HTMLElement, entry: ProviderCatalogSnapshot): void {
  if (!entry.configured) {
    const note = document.createElement('p');
    note.className = 'quota-provider-detail';
    note.textContent = '请先激活 Provider；激活后才会加入模型与额度服务。';
    container.append(note);
    return;
  }
  const quota = entry.quota;
  if (!quota) {
    const note = document.createElement('p');
    note.className = 'quota-provider-detail';
    note.textContent = entry.configured
      ? '已连接；此 Provider 暂不提供额度查询。'
      : entry.authMode === 'native'
        ? '尚未登录，请完成登录后刷新。'
        : entry.authMode === 'api-key'
          ? '尚未配置 Key，配置后可在这里查看额度。'
          : entry.authMode === 'environment'
            ? '尚未配置，请提供环境变量后刷新。'
            : '此 Provider 暂不提供额度查询。';
    container.append(note);
    return;
  }
  const windows = quota.windows;
  const balances = quota.balances;
  if (windows.length > 0) {
    const bars = document.createElement('div');
    bars.className = 'provider-directory-windows';
    for (const window of windows) bars.append(quotaWindowRow(entry, window));
    container.append(bars);
  }
  for (const balance of balances) container.append(quotaBalanceRow(balance));
  if (quota.message || (windows.length === 0 && balances.length === 0)) {
    const note = document.createElement('p');
    note.className = 'quota-provider-message';
    note.textContent = quota.message ?? quota.displayLine ?? '暂无可展示的额度数据。';
    container.append(note);
  } else if (quota.displayLine) {
    const note = document.createElement('p');
    note.className = 'quota-provider-detail';
    note.textContent = quota.displayLine;
    container.append(note);
  }
}

function quotaWindowRow(provider: ProviderCatalogSnapshot, window: QuotaProviderSnapshot['windows'][number]): HTMLElement {
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
  return row;
}

function quotaBalanceRow(balance: QuotaProviderSnapshot['balances'][number]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'quota-balance-row';
  const name = document.createElement('span');
  name.textContent = balance.currency;
  const value = document.createElement('strong');
  value.textContent = balance.display;
  row.append(name, value);
  return row;
}

function providerRowAction(entry: ProviderCatalogSnapshot): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'provider-directory-action';
  const mode = entry.authMode;
  if (mode === 'api-key') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary-button';
    button.textContent = entry.configured ? '更新 Key' : '激活 Provider';
    button.addEventListener('click', () => openProviderDialog(entry));
    wrap.append(button);
    return wrap;
  }
  if (mode === 'native' || mode === 'environment') {
    const hint = document.createElement('span');
    hint.className = 'provider-directory-hint';
    hint.textContent = providerModeHint(mode);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary-button';
    button.textContent = entry.configured ? '查看指引' : '激活 Provider';
    button.addEventListener('click', () => openProviderDialog(entry));
    wrap.append(hint, button);
    return wrap;
  }
  const hint = document.createElement('span');
  hint.className = 'provider-directory-hint';
  hint.textContent = entry.configured ? providerModeHint(mode) : '等待 Runtime 激活';
  wrap.append(hint);
  return wrap;
}

function providerModeHint(mode: ProviderCatalogSnapshot['authMode']): string {
  if (mode === 'api-key') return '支持配置 API Key';
  if (mode === 'native') return '浏览器登录验证';
  if (mode === 'environment') return '由环境变量提供';
  return '无需密钥配置';
}

function openProviderDialog(entry: ProviderCatalogSnapshot): void {
  dialogProvider = entry;
  const mode = entry.authMode;
  const configured = entry.configured;
  const apiKeyMode = mode === 'api-key';
  providerDialogName.textContent = entry.label ?? entry.id;
  providerDialogId.textContent = entry.id;
  providerDialogTitle.textContent = apiKeyMode
    ? (configured ? '更新 API Key' : '配置 API Key')
    : '提供方配置指引';
  providerDialogGuidance.textContent = entry.setupHint || providerDialogGuidanceText(mode);
  providerKeyLabel.hidden = !apiKeyMode;
  providerKeyInput.hidden = !apiKeyMode;
  providerDialogSave.hidden = !apiKeyMode;
  providerDialogError.textContent = '';
  if (apiKeyMode) {
    providerKeyInput.value = '';
    providerKeyInput.disabled = false;
    providerDialogSave.disabled = false;
    providerDialogSave.textContent = configured ? '更新' : '保存';
  }
  providerDialog.hidden = false;
  providerDialog.setAttribute('aria-hidden', 'false');
  if (apiKeyMode) providerKeyInput.focus();
}

function providerDialogGuidanceText(mode: ProviderCatalogSnapshot['authMode']): string {
  if (mode === 'api-key') return '在 Provider 控制台创建 API Key 后粘贴到这里；Key 仅写入本地运行时，不会回显到页面。';
  if (mode === 'native') return '此提供方使用浏览器登录授权，无需 API 密钥。请在提供方登录页完成验证后回到工坊继续使用。';
  if (mode === 'environment') return '此提供方的密钥由启动环境的环境变量提供，本页面不接收密钥输入。请调整启动环境后重新加载会话。';
  return '此提供方无需配置密钥。';
}

function closeProviderDialog(): void {
  providerDialog.hidden = true;
  providerDialog.setAttribute('aria-hidden', 'true');
  providerKeyInput.value = '';
  providerKeyInput.disabled = false;
  providerDialogSave.disabled = false;
  dialogProvider = null;
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
  setText('stats-total-tokens', tokens === undefined ? '—' : formatCompactTokenCount(tokens));
  setText('stats-dispatch-note', statsWindow ? periodLabel(statsWindow.period) : '今日兼容数据');
  setText('stats-token-split', statsWindow
    ? `${periodLabel(statsWindow.period)}总量`
    : today ? `输入 ${formatCompactTokenCount(today.inputTokens)} · 输出 ${formatCompactTokenCount(today.outputTokens)}` : '输入 — · 输出 —');

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

function heatmapTooltipLines(day: StatsSnapshot['daily'][number]): string[] {
  const date = new Date(`${day.dayKey}T12:00:00`);
  const dateLabel = Number.isNaN(date.getTime())
    ? day.dayKey
    : new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
      }).format(date);
  const lines = [
    dateLabel,
    `${formatCompactTokenCount(day.totalTokens)} Token · ${formatCount(day.dispatchCount)} 次调度`,
    `输入 ${formatCompactTokenCount(day.inputTokens)} · 输出 ${formatCompactTokenCount(day.outputTokens)}`,
  ];
  if (day.outcomes) {
    lines.push(`完成 ${formatCount(day.outcomes.done)} · 失败 ${formatCount(day.outcomes.failed)} · 取消 ${formatCount(day.outcomes.cancelled)}`);
  }
  return lines;
}

function showHeatTooltip(cell: HTMLElement, lines: string[]): void {
  statsHeatTooltip.textContent = lines.join('\n');
  statsHeatTooltip.hidden = false;
  const cellRect = cell.getBoundingClientRect();
  const tooltipRect = statsHeatTooltip.getBoundingClientRect();
  const left = Math.min(
    window.innerWidth - tooltipRect.width / 2 - 10,
    Math.max(tooltipRect.width / 2 + 10, cellRect.left + cellRect.width / 2),
  );
  const above = cellRect.top - tooltipRect.height - 9;
  statsHeatTooltip.style.left = `${left - tooltipRect.width / 2}px`;
  statsHeatTooltip.style.top = `${above >= 8 ? above : cellRect.bottom + 9}px`;
}

function hideHeatTooltip(): void {
  statsHeatTooltip.hidden = true;
}

function renderDaily(snapshot: StatsSnapshot): void {
  const list = requireElement('stats-daily-list');
  const months = requireElement('stats-heat-months');
  const model = buildActivityHeatmap(snapshot.daily.slice(-365));
  hideHeatTooltip();
  if (model.slots.length === 0) {
    list.classList.add('is-empty');
    list.replaceChildren(emptyRow('暂无每日活动记录'));
    months.replaceChildren();
    return;
  }
  list.classList.remove('is-empty');
  const monthByWeek = new Map(model.months.map((month) => [month.weekIndex, month.label]));
  months.replaceChildren(...Array.from({ length: model.weekCount }, (_, weekIndex) => {
    const label = document.createElement('span');
    label.textContent = monthByWeek.get(weekIndex) ?? '';
    return label;
  }));
  list.replaceChildren(...model.slots.map((slot) => {
    if (!slot.day) {
      const placeholder = document.createElement('span');
      placeholder.className = 'heat-cell is-placeholder';
      placeholder.setAttribute('aria-hidden', 'true');
      return placeholder;
    }
    const item = slot.day;
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = `heat-cell heat-${slot.level}${item.dayKey === snapshot.today?.dayKey ? ' is-today' : ''}`;
    cell.setAttribute('role', 'listitem');
    const tooltipLines = heatmapTooltipLines(item);
    cell.setAttribute('aria-label', tooltipLines.join('，'));
    cell.setAttribute('aria-describedby', 'stats-heat-tooltip');
    cell.tabIndex = item.totalTokens > 0 || item.dayKey === snapshot.today?.dayKey ? 0 : -1;
    cell.addEventListener('pointerenter', () => showHeatTooltip(cell, tooltipLines));
    cell.addEventListener('pointerleave', hideHeatTooltip);
    cell.addEventListener('focus', () => showHeatTooltip(cell, tooltipLines));
    cell.addEventListener('blur', hideHeatTooltip);
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
      formatCompactTokenCount(row.totalTokens),
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
  const pageTitle = page === 'stats' ? '工房台账' : page === 'quota' ? '模型供应' : '设置';
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
updateActionButton.addEventListener('click', () => void runUpdateAction());
updateChannelSwitcher.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const channel = target.dataset.updateChannel;
  if (channel === 'stable' || channel === 'dev') void selectUpdateChannel(channel);
});
providerDialogCancel.addEventListener('click', () => closeProviderDialog());
providerDialogSave.addEventListener('click', () => {
  const entry = dialogProvider;
  if (!entry) return;
  const apiKey = providerKeyInput.value.trim();
  if (!apiKey) {
    providerDialogError.textContent = '请输入 API Key。';
    providerKeyInput.focus();
    return;
  }
  providerDialogSave.disabled = true;
  providerKeyInput.disabled = true;
  providerDialogError.textContent = '';
  void window.wrenyardShell.configureProviderKey(entry.id, apiKey)
    .then((snapshot) => {
      closeProviderDialog();
      renderQuota(snapshot);
    })
    .catch((error: unknown) => {
      providerDialogError.textContent = error instanceof Error ? error.message : '密钥保存失败，请重试。';
      providerDialogSave.disabled = false;
      providerKeyInput.disabled = false;
    });
});
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
  if (event.key === 'Escape' && !providerDialog.hidden) {
    event.preventDefault();
    closeProviderDialog();
    return;
  }
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
window.wrenyardShell.onUpdateChanged(() => {
  void window.wrenyardShell.getUpdate().then(renderUpdate);
});
const refreshDaemonStatus = (): void => {
  void window.wrenyardShell.getSettings()
    .then((snapshot) => renderDaemonStatus(snapshot.service))
    .catch(() => renderDaemonStatus({ status: 'unavailable' }));
};
const daemonStatus = requireElement('conversation-daemon-status');
daemonStatus.addEventListener('pointerenter', refreshDaemonStatus);
daemonStatus.addEventListener('focus', refreshDaemonStatus);
void window.wrenyardShell.getSettings()
  .then(renderSnapshot)
  .catch(() => renderDaemonStatus({ status: 'unavailable' }));
const conversationView = new ConversationView(window.wrenyardShell, () => void navigate('settings'));
conversationView.start();
