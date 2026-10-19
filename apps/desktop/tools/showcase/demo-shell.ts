/**
 * Deterministic, privacy-safe in-memory implementation of {@link WrenyardShellApi}
 * for product screenshots and promo recordings.
 *
 * Source-only showcase tooling: it is never bundled into the shipped product.
 * Every value is fictional (workspace `~/workspace`, device
 * `Demo MacBook Pro`) and every generated series is seeded, so repeated runs
 * render identical screens. Timestamps are anchored to `Date.now()` at module
 * load, so relative labels (今天, 2 分钟前) stay correct on any capture day.
 */

import type { LedgerEvent, LedgerEventDraft } from '@wrenyard/session';
import {
  isPreferenceId,
  validatePreferenceValue,
  type ActivityStatusSnapshot,
  type AgentBot,
  type OperationComponentSnapshot,
  type RemoteConnectionSnapshot,
  type Routine,
  type StorageUsageSnapshot,
  type AppearanceSettings,
  type AppNotification,
  type NotificationEntry,
  type NotificationSnapshot,
  type DaemonLifecycleSnapshot,
  type DesktopPreferences,
  type ExecEventsResult,
  type ExecSnapshotDto,
  type ModelSnapshot,
  type PetCompanionSettings,
  type PreferenceId,
  type ProviderCatalogSnapshot,
  type ProviderModelSnapshot,
  type QuotaProviderSnapshot,
  type QuotaSnapshot,
  type QuotaWindowSnapshot,
  type ResolvedAppearance,
  type SettingsSnapshot,
  type ShellPage,
  type StatsDailySnapshot,
  type StatsSnapshot,
  type StatsTodaySnapshot,
  type StatsWindowSnapshot,
  type TaskRoutingTestResult,
  type TaskRoutingTestRow,
  type TaskRoutingTestTask,
  type TaskRoutingTestTasksResult,
  type TaskRunSnapshot,
  type TaskSettingsAutomaticSelection,
  type TaskSettingsEffective,
  type TaskSettingsInstructionTemplate,
  type TaskSettingsSnapshot,
  type TaskSettingsTaskRow,
  type Todo,
  type UpdateSnapshot,
  type WorkspaceConfigurationSnapshot,
  type WrenyardShellApi,
} from '../../src/shell-contract';

/* ------------------------------------------------------------------ */
/* Time anchors and small utilities                                    */
/* ------------------------------------------------------------------ */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Module-load anchor: every relative timestamp is derived from this. */
const NOW = Date.now();

const WORKSPACE_ROOT = '~/workspace';
const DEVICE_NAME = 'Demo MacBook Pro';
const VERSION = '1.0.0-dev.45';
const IPC_ENDPOINT = '~/.local/state/wrenyard/daemon.sock';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayKeyOf(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Today at a fixed wall-clock time, used for the build timestamp. */
function todayAt(hours: number, minutes: number): number {
  const date = new Date(NOW);
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
}

/** mulberry32: tiny deterministic PRNG so generated series never drift. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Emitter<T> {
  subscribe(listener: (value: T) => void): () => void;
  emit(value: T): void;
}

function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(value) {
      for (const listener of [...listeners]) listener(value);
    },
  };
}

interface VoidEmitter {
  subscribe(listener: () => void): () => void;
  emit(): void;
}

function createVoidEmitter(): VoidEmitter {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Public surface                                                      */
/* ------------------------------------------------------------------ */

/** Optional sink the harness uses to observe page changes. */
export interface DemoControl {
  emitView(page: ShellPage): void;
}

/** Theme/dark/motion switch consumed by the showcase runner. */
export interface DemoAppearanceInput {
  theme: string;
  dark: boolean;
  reduceMotion?: boolean;
}

export interface DemoShell {
  /** The fully typed in-memory bridge. */
  api: WrenyardShellApi;
  /** Switch the visible page and notify any mounted view listener. */
  setPage(page: ShellPage): void;
  /** Switch theme/dark/reduced-motion and notify the appearance listener. */
  setAppearance(appearance: DemoAppearanceInput): void;
  /** Alias of {@link DemoShell.setPage}, for the `emitView` control hook. */
  emitView(page: ShellPage): void;
}

/* ------------------------------------------------------------------ */
/* Appearance, daemon, service                                         */
/* ------------------------------------------------------------------ */

const INITIAL_APPEARANCE: ResolvedAppearance = { theme: 'paper', dark: false, reduceMotion: false };

const appearanceChanged = createEmitter<ResolvedAppearance>();
const viewChanged = createEmitter<ShellPage>();
const daemonChanged = createVoidEmitter();
const quotaChanged = createVoidEmitter();
const updateChanged = createVoidEmitter();
const activityChanged = createEmitter<ActivityStatusSnapshot>();
const notificationShow = createEmitter<AppNotification>();
const notificationsChanged = createVoidEmitter();
const preferencesChanged = createEmitter<DesktopPreferences>();

let resolvedAppearance: ResolvedAppearance = { ...INITIAL_APPEARANCE };
let appearanceSettings: AppearanceSettings = { theme: 'paper', colorMode: 'light', motion: 'system', zoom: 100 };

let daemonSnapshot: DaemonLifecycleSnapshot = {
  mode: 'supervised',
  state: 'running',
  canStart: true,
  restartCount: 0,
  pid: 43120,
};

let updateSnapshot: UpdateSnapshot = {
  state: 'up-to-date',
  currentVersion: VERSION,
  checkedAt: NOW - 5 * MINUTE,
  installSupported: true,
};

let workspaceSnapshot: WorkspaceConfigurationSnapshot = {
  status: 'configured',
  source: 'user-config',
  configPath: '~/.config/wrenyard/workspace.json',
  path: WORKSPACE_ROOT,
  readOnly: false,
};

const ABOUT: SettingsSnapshot['about'] = {
  desktopVersion: VERSION,
  wrenyardVersion: VERSION,
  buildTime: iso(todayAt(10, 20)),
};

const PET_SETTINGS_DEFAULT: PetCompanionSettings = {
  enabled: false,
  displayId: 1,
  scale: 3,
  bubbleSeconds: 6,
  bottomOffset: 0,
  entities: { house: true, workers: true, taskgraphs: true },
  appearance: { houseSkin: 'classic' },
  quota: {
    providers: [
      { id: 'anthropic', enabled: true },
      { id: 'chatgpt', enabled: true },
      { id: 'kimi-coding', enabled: true },
      { id: 'zhipu-coding', enabled: true },
      { id: 'cursor', enabled: true },
      { id: 'deepseek', enabled: true },
    ],
  },
};

let petSettings: PetCompanionSettings = PET_SETTINGS_DEFAULT;

/* ------------------------------------------------------------------ */
/* Quota: providers, catalog, order                                    */
/* ------------------------------------------------------------------ */

const PROVIDER_IDS = ['anthropic', 'chatgpt', 'kimi-coding', 'zhipu-coding', 'cursor', 'deepseek'] as const;

function quotaWindow(
  name: string,
  remainingPct: number,
  expectedRemainingPct: number | null,
  resetsAtOffsetMs: number | null,
  windowMinutes: number,
): QuotaWindowSnapshot {
  return {
    name,
    remainingPct,
    expectedRemainingPct,
    resetsAt: resetsAtOffsetMs === null ? undefined : iso(NOW + resetsAtOffsetMs),
    windowMinutes,
  };
}

function quotaProvider(
  id: string,
  label: string,
  windows: QuotaWindowSnapshot[],
  balances: QuotaProviderSnapshot['balances'] = [],
): QuotaProviderSnapshot {
  return { id, label, status: 'ok', stale: false, windows, balances };
}

const PROVIDERS: QuotaProviderSnapshot[] = [
  quotaProvider('anthropic', 'Anthropic', [
    quotaWindow('5h', 64, 58, 2 * HOUR + 5 * MINUTE, 300),
    quotaWindow('7d', 58, 61, 3 * DAY + 4 * HOUR, 10080),
  ]),
  quotaProvider('chatgpt', 'ChatGPT', [
    quotaWindow('5h', 88, 70, 3 * HOUR + 40 * MINUTE, 300),
    quotaWindow('7d', 74, 66, 4 * DAY + 11 * HOUR, 10080),
  ]),
  quotaProvider('kimi-coding', 'Kimi Coding', [
    quotaWindow('5h', 92, 81, 1 * HOUR + 27 * MINUTE, 300),
    quotaWindow('7d', 81, 77, 1 * DAY + 15 * HOUR, 10080),
  ]),
  quotaProvider('zhipu-coding', 'Zhipu Coding', [
    quotaWindow('5h', 100, null, 4 * HOUR + 12 * MINUTE, 300),
    quotaWindow('7d', 69, 60, 2 * DAY + 15 * HOUR, 10080),
  ]),
  quotaProvider('cursor', 'Cursor', [quotaWindow('1mo', 63, 57, 18 * DAY, 43200)]),
  quotaProvider('deepseek', 'DeepSeek', [], [
    { currency: 'CNY', amount: '86.20', display: '¥86.20' },
  ]),
];

const QUOTA_BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

function catalogModel(
  id: string,
  displayName: string,
  pricing: readonly [number, number, number],
  intelligence: 'low' | 'mid' | 'high' | 'premium',
  effectiveTps: number,
): ProviderModelSnapshot {
  return {
    id,
    displayName,
    canonicalId: id,
    intelligence,
    effectiveTps,
    pricing,
    speedSource: 'catalog_default',
    available: true,
  };
}

const CATALOG: ProviderCatalogSnapshot[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude 系列模型，长上下文与复杂推理表现稳定。',
    configured: true,
    authMode: 'api-key',
    setupHint: '在 Anthropic 控制台创建 API Key 后填入。',
    quota: QUOTA_BY_ID.get('anthropic'),
    models: [
      catalogModel('claude-opus-5.5', 'Claude Opus 5.5', [1.5, 15, 75], 'premium', 42),
      catalogModel('claude-sonnet-5.5', 'Claude Sonnet 5.5', [0.3, 3, 15], 'high', 68),
    ],
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    description: 'OpenAI 系列模型，擅长大规模代码与工具调用。',
    configured: true,
    authMode: 'api-key',
    setupHint: '在 OpenAI 控制台创建 API Key 后填入。',
    quota: QUOTA_BY_ID.get('chatgpt'),
    models: [
      catalogModel('gpt-5.6-sol', 'GPT 5.6 Sol', [0.25, 2.5, 10], 'premium', 55),
      catalogModel('gpt-5.6-luna', 'GPT 5.6 Luna', [0.1, 1, 4], 'high', 90),
    ],
  },
  {
    id: 'kimi-coding',
    label: 'Kimi Coding',
    description: '面向编码的长上下文模型，性价比高。',
    configured: true,
    authMode: 'api-key',
    setupHint: '在 Kimi 开放平台创建 API Key 后填入。',
    quota: QUOTA_BY_ID.get('kimi-coding'),
    models: [catalogModel('kimi-k3', 'Kimi K3', [0.08, 0.8, 3.2], 'high', 118)],
  },
  {
    id: 'zhipu-coding',
    label: 'Zhipu Coding',
    description: 'GLM 系列编码模型，速度与成本均衡。',
    configured: true,
    authMode: 'api-key',
    setupHint: '在智谱开放平台创建 API Key 后填入。',
    quota: QUOTA_BY_ID.get('zhipu-coding'),
    models: [
      catalogModel('glm-5.3', 'GLM 5.3', [0.05, 0.5, 2], 'high', 94),
      catalogModel('glm-5.3-flash', 'GLM 5.3 Flash', [0.02, 0.2, 0.8], 'mid', 180),
    ],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    description: 'Cursor 订阅内置模型，随订阅额度调度。',
    configured: true,
    authMode: 'native',
    setupHint: '登录 Cursor 账号即可使用订阅额度。',
    quota: QUOTA_BY_ID.get('cursor'),
    models: [
      catalogModel('composer-2', 'Composer 2', [0.5, 5, 20], 'high', 60),
      catalogModel('grok-4.7', 'Grok 4.7', [0.5, 2, 6], 'high', 59),
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek 系列模型，按余额计费。',
    configured: true,
    authMode: 'api-key',
    setupHint: '在 DeepSeek 开放平台创建 API Key 后填入。',
    quota: QUOTA_BY_ID.get('deepseek'),
    models: [
      catalogModel('deepseek-v4.1', 'DeepSeek V4.1', [0.08, 0.8, 3.2], 'high', 110),
      catalogModel('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', [0.03, 0.3, 1.2], 'mid', 200),
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: '聚合多家模型的统一入口。',
    configured: false,
    authMode: 'none',
    setupHint: '在 OpenRouter 生成 API Key 后填入。',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    description: 'Google Gemini 系列模型。',
    configured: false,
    authMode: 'none',
    setupHint: '在 Google AI Studio 创建 API Key 后填入。',
  },
  {
    id: 'qwen',
    label: 'Qwen',
    description: '通义千问系列模型。',
    configured: false,
    authMode: 'none',
    setupHint: '在阿里云百炼创建 API Key 后填入。',
  },
];

let providerOrderIds: string[] = [...PROVIDER_IDS];

function buildQuota(): QuotaSnapshot {
  return {
    status: 'available',
    providers: PROVIDERS,
    catalog: CATALOG,
    providerOrder: providerOrderIds.map((id) => ({ id, enabled: true })),
    refreshedAt: NOW - MINUTE,
  };
}

/* ------------------------------------------------------------------ */
/* Settings models                                                     */
/* ------------------------------------------------------------------ */

const SETTINGS_MODELS: ModelSnapshot[] = CATALOG.filter((provider) => provider.configured).flatMap(
  (provider) =>
    (provider.models ?? []).map((model) => ({
      id: `${provider.id}/${model.id}`,
      quotaProvider: provider.id,
      label: model.displayName,
      configured: true,
    })),
);

function buildSettings(): SettingsSnapshot {
  return {
    service: {
      status: 'connected',
      endpoint: IPC_ENDPOINT,
      workspace: workspaceSnapshot,
      uptimeMs: 3 * HOUR + 12 * MINUTE,
    },
    models: SETTINGS_MODELS,
    pet: {
      settings: petSettings,
      status: 'stopped',
      displays: [{ id: 1, label: DEVICE_NAME, isPrimary: true }],
    },
    update: updateSnapshot,
    about: ABOUT,
  };
}

/* ------------------------------------------------------------------ */
/* Activity and notifications                                          */
/* ------------------------------------------------------------------ */

const ACTIVITY: ActivityStatusSnapshot = {
  sampledAt: iso(NOW - 5 * SECOND),
  stale: false,
  tasks: [
    {
      taskRunId: 'tr-2101',
      status: 'running',
      taskId: 'explore',
      taskLabel: '探索调查',
      project: 'aurora',
      taskgraphId: 'tg-9001',
      startedAt: iso(NOW - 3 * MINUTE),
    },
    {
      taskRunId: 'tr-2102',
      status: 'running',
      taskId: 'edit',
      taskLabel: '编辑文件',
      project: 'aurora',
      taskgraphId: 'tg-9001',
      startedAt: iso(NOW - 50 * SECOND),
    },
    {
      taskRunId: 'tr-2103',
      status: 'queued',
      taskId: 'test',
      taskLabel: '运行验证',
      project: 'console',
      startedAt: iso(NOW - 10 * SECOND),
    },
  ],
  taskgraphs: [
    {
      taskgraphId: 'tg-9001',
      title: '支付重试改造',
      project: 'aurora',
      state: 'running',
      nodeCounts: { done: 3, running: 2, planned: 2 },
    },
  ],
};

/*
 * In-memory notification history for the bell panel: a few sample entries,
 * newest first. Dismiss/clear/mark-read mutate it and emit `changed`.
 */
const NOTIFICATION_SAMPLE: NotificationEntry[] = [
  {
    id: 'demo:task-done',
    level: 'success',
    title: '完成',
    body: '探索调查 · aurora',
    action: { label: '查看', command: { id: 'tasks.open', args: { taskRunId: 'tr-2101' } } },
    createdAt: NOW - 2 * MINUTE,
    read: false,
  },
  {
    id: 'demo:quota',
    level: 'warning',
    title: '额度告警',
    body: 'Kimi Coding 5h 剩余 28%',
    action: { label: '查看额度', command: { id: 'quota.showPanel' } },
    createdAt: NOW - 18 * MINUTE,
    read: false,
  },
  {
    id: 'demo:daemon',
    level: 'warning',
    title: 'Daemon 连接已断开',
    createdAt: NOW - 40 * MINUTE,
    read: true,
  },
];

let notificationEntries: NotificationEntry[] = NOTIFICATION_SAMPLE.map((entry) => ({ ...entry }));

function snapshotNotifications(): NotificationSnapshot {
  return {
    items: notificationEntries.map((entry) => ({ ...entry })),
    unreadCount: notificationEntries.reduce((count, entry) => (entry.read ? count : count + 1), 0),
  };
}

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

interface ProfileBase {
  name: string;
  model: string;
  modelDisplayName: string;
  providerDisplayNames: string[];
  runCount: number;
  totalTokens: number;
  averageTps: number;
}

const PROFILE_BASE: ProfileBase[] = [
  {
    name: 'deepseek-v4.1-flash',
    model: 'deepseek-v4.1-flash',
    modelDisplayName: 'DeepSeek V4.1 Flash',
    providerDisplayNames: ['DeepSeek'],
    runCount: 18,
    totalTokens: 16_500_000,
    averageTps: 198,
  },
  {
    name: 'kimi-k3',
    model: 'kimi-k3',
    modelDisplayName: 'Kimi K3',
    providerDisplayNames: ['Kimi Coding'],
    runCount: 12,
    totalTokens: 12_400_000,
    averageTps: 118,
  },
  {
    name: 'glm-5.3',
    model: 'glm-5.3',
    modelDisplayName: 'GLM 5.3',
    providerDisplayNames: ['Zhipu Coding'],
    runCount: 9,
    totalTokens: 8_200_000,
    averageTps: 94,
  },
  {
    name: 'claude-sonnet-5.5',
    model: 'claude-sonnet-5.5',
    modelDisplayName: 'Claude Sonnet 5.5',
    providerDisplayNames: ['Anthropic'],
    runCount: 7,
    totalTokens: 7_900_000,
    averageTps: 66,
  },
];

interface TaskBase {
  name: string;
  source: 'builtin' | 'project';
  runCount: number;
  durationMs: number;
}

const TASK_BASE: TaskBase[] = [
  { name: 'explore', source: 'builtin', runCount: 14, durationMs: 44 * MINUTE },
  { name: 'edit', source: 'builtin', runCount: 11, durationMs: 52 * MINUTE },
  { name: 'test', source: 'builtin', runCount: 9, durationMs: 31 * MINUTE },
  { name: 'code-review', source: 'builtin', runCount: 5, durationMs: 18 * MINUTE },
  { name: 'commit', source: 'builtin', runCount: 4, durationMs: 6 * MINUTE },
  { name: 'librarian', source: 'builtin', runCount: 2, durationMs: 5 * MINUTE },
  { name: 'aurora:release-check', source: 'project', runCount: 1, durationMs: 7 * MINUTE },
];

function scaleProfiles(factor: number): StatsWindowSnapshot['byProfile'] {
  return PROFILE_BASE.map((row) => ({
    name: row.name,
    model: row.model,
    modelDisplayName: row.modelDisplayName,
    providerDisplayNames: row.providerDisplayNames,
    runCount: Math.max(1, Math.round(row.runCount * factor)),
    totalTokens: Math.round(row.totalTokens * factor),
    averageTps: row.averageTps,
  }));
}

function scaleTasks(factor: number, onlyBuiltin: boolean): StatsWindowSnapshot['byTask'] {
  return TASK_BASE.filter((row) => !onlyBuiltin || row.source === 'builtin').map((row) => {
    const durationMs = Math.round(row.durationMs * factor);
    const runCount = Math.max(1, Math.round(row.runCount * factor));
    return {
      name: row.name,
      source: row.source,
      runCount,
      durationMs,
      averageDurationMs: Math.round(durationMs / runCount),
    };
  });
}

function statsWindow(
  period: StatsWindowSnapshot['period'],
  factor: number,
  dispatchCount: number,
  totalTokens: number,
  totalDurationMs: number,
): StatsWindowSnapshot {
  const startAt = period === '24h' ? NOW - DAY : period === '7d' ? NOW - 7 * DAY : NOW - 30 * DAY;
  return {
    period,
    startAt: iso(startAt),
    endAt: iso(NOW),
    dispatchCount,
    totalTokens,
    totalDurationMs,
    builtinTotalDurationMs: Math.round(totalDurationMs * 0.56),
    byProfile: scaleProfiles(factor),
    byTask: scaleTasks(factor, false),
    byBuiltinTask: scaleTasks(factor, true),
  };
}

function buildDaily(): StatsDailySnapshot[] {
  const random = mulberry32(7);
  const dayStart = startOfDay(NOW);
  const rows: StatsDailySnapshot[] = [];
  for (let offset = 364; offset >= 0; offset -= 1) {
    const dateStart = dayStart - offset * DAY;
    const weekday = new Date(dateStart).getDay();
    const weekend = weekday === 0 || weekday === 6;
    const ramp = offset > 90 ? 0.45 : 0.5 + ((90 - offset) / 90) * 1.15;
    const empty = random() < (weekend ? 0.34 : 0.07);
    const base = weekend ? 4 + random() * 10 : 24 + random() * 34;
    const dispatchCount = empty ? 0 : Math.max(1, Math.round(base * ramp));
    const inputTokens = dispatchCount === 0 ? 0 : Math.round(dispatchCount * (1.9 + random() * 1.1) * 1_000_000);
    const outputTokens = dispatchCount === 0 ? 0 : Math.round(dispatchCount * (0.42 + random() * 0.3) * 1_000_000);
    const failed = dispatchCount === 0 ? 0 : random() < 0.72 ? 0 : Math.max(1, Math.round(dispatchCount * 0.03));
    rows.push({
      dayKey: dayKeyOf(dateStart),
      dispatchCount,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      outcomes: { done: dispatchCount - failed, failed, cancelled: 0 },
    });
  }
  return rows;
}

const TODAY: StatsTodaySnapshot = {
  dayKey: dayKeyOf(NOW),
  startAt: iso(startOfDay(NOW)),
  endAt: iso(startOfDay(NOW) + DAY),
  dispatchCount: 11,
  inputTokens: 9_400_000,
  outputTokens: 2_100_000,
  totalTokens: 11_500_000,
  outcomes: { done: 10, failed: 1, cancelled: 0, running: 1 },
  taskDispatches: { count: 9, done: 8 },
};

interface RunProfile {
  profile: string;
  model: string;
  provider: string;
  providerName: string;
  modelName: string;
  tps: number;
}

const RUN_PROFILES: RunProfile[] = [
  { profile: 'deepseek-v4.1-flash', model: 'deepseek-v4.1-flash', provider: 'deepseek', providerName: 'DeepSeek', modelName: 'DeepSeek V4.1 Flash', tps: 198 },
  { profile: 'kimi-k3', model: 'kimi-k3', provider: 'kimi-coding', providerName: 'Kimi Coding', modelName: 'Kimi K3', tps: 118 },
  { profile: 'glm-5.3', model: 'glm-5.3', provider: 'zhipu-coding', providerName: 'Zhipu Coding', modelName: 'GLM 5.3', tps: 94 },
  { profile: 'claude-sonnet-5.5', model: 'claude-sonnet-5.5', provider: 'anthropic', providerName: 'Anthropic', modelName: 'Claude Sonnet 5.5', tps: 66 },
];

const RUN_TASKS: Array<{ id: string; name: string }> = [
  { id: 'edit', name: '编辑文件' },
  { id: 'explore', name: '探索调查' },
  { id: 'test', name: '运行验证' },
  { id: 'code-review', name: '变更审查' },
  { id: 'commit', name: '提交更改' },
  { id: 'librarian', name: '资料研究' },
];

const RUN_PROJECTS = ['aurora', 'console', 'docs-site'];

function buildRecentRuns(): TaskRunSnapshot[] {
  const random = mulberry32(7);
  const runs: TaskRunSnapshot[] = [];
  let cursor = NOW - 4 * MINUTE;
  for (let index = 0; index < 24; index += 1) {
    const task = RUN_TASKS[index % RUN_TASKS.length];
    const profile = RUN_PROFILES[index % RUN_PROFILES.length];
    const project = RUN_PROJECTS[index % RUN_PROJECTS.length];
    const durationMs = Math.round(20_000 + random() * 520_000);
    const inputTokens = Math.round(180_000 + random() * 2_400_000);
    const outputTokens = Math.round(9_000 + random() * 90_000);
    const status = index === 2 ? 'running' : index === 7 || index === 18 ? 'failed' : 'done';
    const finishedAt = status === 'running' ? undefined : cursor + durationMs;
    runs.push({
      taskRunId: `tr-${1000 + index}`,
      taskId: task.id,
      taskName: task.name,
      source: 'builtin',
      project,
      status,
      startedAt: iso(cursor),
      finishedAt: finishedAt === undefined ? undefined : iso(finishedAt),
      resolvedClient: 'codex',
      resolvedProvider: profile.provider,
      resolvedProfile: profile.profile,
      resolvedModel: profile.model,
      resolvedModelId: profile.model,
      resolvedProviderDisplayName: profile.providerName,
      resolvedModelDisplayName: profile.modelName,
      speed: {
        effectiveTps: profile.tps,
        source: 'local_31d',
        sampleCount: 18 + index,
        expectedTpsMet: status !== 'failed',
        degradationReason: status === 'failed' ? '运行中断，未达预期吞吐' : undefined,
      },
      usage: {
        completeness: 'complete',
        attemptCount: 1,
        usageEventCount: 8 + (index % 7),
        inputTokens,
        cachedInputTokens: Math.round(inputTokens * 0.6),
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        generationMs: durationMs,
        outputTps: profile.tps,
        referenceCostUsd: Number(((inputTokens / 1_000_000) * 0.8 + (outputTokens / 1_000_000) * 3.2).toFixed(4)),
        referenceCostComplete: true,
        referenceCostBasis: 'catalog',
      },
    });
    cursor -= Math.round(9 * MINUTE + random() * 40 * MINUTE);
  }
  return runs;
}

const STATS: StatsSnapshot = {
  status: 'available',
  today: TODAY,
  daily: buildDaily(),
  windows: [
    statsWindow('24h', 1, 46, 128_000_000, 3 * HOUR + 18 * MINUTE),
    statsWindow('7d', 6.2, 284, 812_000_000, 21 * HOUR + 40 * MINUTE),
    statsWindow('1mo', 24.5, 1_126, 3_100_000_000, 86 * HOUR),
  ],
  recentTaskRuns: buildRecentRuns(),
};

/* ------------------------------------------------------------------ */
/* Task settings                                                       */
/* ------------------------------------------------------------------ */

const TASK_TIMEOUT_MS = 30 * MINUTE;

const INSTRUCTION_TEMPLATE_TEXT = [
  'Goal',
  'Achieve the requested outcome for this workspace.',
  'Keep the change focused, minimal, and verifiable.',
  'Work from evidence in the repository, not assumptions.',
  '',
  'Inputs',
  '- The current workspace under the workspace root.',
  '- The task prompt supplied by the caller.',
  '- Existing files, tests, and configuration.',
  '- Any notes or specs referenced by the prompt.',
  '',
  'Boundaries',
  '- Change only what the task requires.',
  '- Do not add dependencies or rewrite build configuration.',
  '- Do not commit, push, or open pull requests.',
  '- Stop and report when a required detail is missing.',
  '',
  'Report',
  '- Summarize what changed and why.',
  '- List every file you touched.',
  '- Give the exact commands used to verify.',
  '- Note follow-up work and open questions.',
  '',
].join('\n');

function instructionTemplate(): TaskSettingsInstructionTemplate {
  return INSTRUCTION_TEMPLATE_TEXT.split('\n').map((line) => ({
    kind: 'text',
    source: 'template',
    text: line,
  }));
}

function effectiveSettings(): TaskSettingsEffective {
  return {
    routing_weights: { value: { price: 0.3, speed: 0.3, quota: 0.2, intelligence: 0.2 }, source: 'system' },
    mode: { value: 'automatic', source: 'system' },
    explicit_runtime: { value: null, source: 'system' },
    timeout_ms: { value: TASK_TIMEOUT_MS, source: 'system' },
    automatic: {
      expected_tps: { value: null, source: 'system' },
      minimum_tps: { value: null, source: 'system' },
      intelligence_min: { value: 'mid', source: 'system' },
      intelligence_expected: { value: 'high', source: 'system' },
      max_output_usd_per_million: { value: null, source: 'system' },
      required_capabilities: { value: ['text'], source: 'system' },
      requires_web_search: { value: false, source: 'system' },
      exclude_model_ids: { value: [], source: 'system' },
      exclude_profile_ids: { value: [], source: 'system' },
      exclude_client_ids: { value: [], source: 'system' },
      exclude_provider_ids: { value: [], source: 'system' },
    },
  };
}

function automaticSelection(taskName: string): TaskSettingsAutomaticSelection {
  return {
    exact_runtime: 'deepseek/deepseek-v4.1-flash',
    resolved: {
      runtime: 'deepseek/deepseek-v4.1-flash:codex',
      client: 'codex',
      provider: 'deepseek',
      model: 'deepseek-v4.1-flash',
      model_id: 'deepseek-v4.1-flash',
      provider_display_name: 'DeepSeek',
      model_display_name: 'DeepSeek V4.1 Flash',
    },
    reason: `${taskName}：按价格、速度、额度与智能综合评分自动选择`,
  };
}

interface TaskRowOptions {
  identity: string;
  name: string;
  displayName: string;
  project?: string;
  source: string;
  promptTemplate: 'dynamic' | 'fixed';
}

function taskRow(options: TaskRowOptions): TaskSettingsTaskRow {
  return {
    identity: options.identity,
    name: options.name,
    display_name: options.displayName,
    project: options.project,
    project_display_name: options.project === undefined ? undefined : 'Aurora',
    builtin: {
      identity: options.identity,
      name: options.name,
      source: options.source,
      description: `${options.displayName}任务的默认说明。`,
      project: options.project,
      prompt_template: options.promptTemplate,
      instruction_template: instructionTemplate(),
      timeout_ms: TASK_TIMEOUT_MS,
      dispatch: { intelligence_min: 'mid', required_capabilities: ['text'] },
    },
    user_task: {},
    effective: effectiveSettings(),
    automatic_selection: automaticSelection(options.name),
    issues: [],
  };
}

const TASK_ROWS: TaskSettingsTaskRow[] = [
  taskRow({ identity: 'builtin:explore', name: 'explore', displayName: '探索调查', source: 'builtin', promptTemplate: 'dynamic' }),
  taskRow({ identity: 'builtin:edit', name: 'edit', displayName: '编辑文件', source: 'builtin', promptTemplate: 'fixed' }),
  taskRow({ identity: 'builtin:test', name: 'test', displayName: '运行验证', source: 'builtin', promptTemplate: 'dynamic' }),
  taskRow({ identity: 'builtin:code-review', name: 'code-review', displayName: '变更审查', source: 'builtin', promptTemplate: 'fixed' }),
  taskRow({ identity: 'builtin:commit', name: 'commit', displayName: '提交更改', source: 'builtin', promptTemplate: 'fixed' }),
  taskRow({ identity: 'builtin:librarian', name: 'librarian', displayName: '资料研究', source: 'builtin', promptTemplate: 'fixed' }),
  taskRow({ identity: 'builtin:oracle', name: 'oracle', displayName: '分析顾问', source: 'builtin', promptTemplate: 'dynamic' }),
  taskRow({ identity: 'project:aurora:release-check', name: 'release-check', displayName: '发布前检查', project: 'aurora', source: 'project', promptTemplate: 'fixed' }),
  taskRow({ identity: 'project:aurora:api-contract-review', name: 'api-contract-review', displayName: '接口契约审查', project: 'aurora', source: 'project', promptTemplate: 'fixed' }),
];

const TASK_SETTINGS: TaskSettingsSnapshot = {
  config_path: '~/.config/wrenyard/task-settings.json',
  revision: '42',
  project: 'aurora',
  user_global: {},
  rows: TASK_ROWS,
};

const ROUTING_TASKS: TaskRoutingTestTask[] = TASK_ROWS.map((row) => ({
  identity: row.identity,
  name: row.name,
  display_name: row.display_name,
  project: row.project,
  automatic: row.builtin.dispatch,
  timeout_ms: TASK_TIMEOUT_MS,
}));

const ROUTING_CANDIDATES: Array<Omit<TaskRoutingTestRow, 'rank' | 'reason'>> = [
  { provider: 'deepseek', provider_name: 'DeepSeek', model: 'deepseek-v4.1-flash', model_name: 'DeepSeek V4.1 Flash', effective_tps: 200, price_score: 1, speed_score: 1, quota_score: 0.9, intelligence_score: 0.75, score: 0.94 },
  { provider: 'kimi-coding', provider_name: 'Kimi Coding', model: 'kimi-k3', model_name: 'Kimi K3', effective_tps: 118, price_score: 0.92, speed_score: 0.74, quota_score: 0.88, intelligence_score: 0.84, score: 0.84 },
  { provider: 'zhipu-coding', provider_name: 'Zhipu Coding', model: 'glm-5.3', model_name: 'GLM 5.3', effective_tps: 94, price_score: 0.96, speed_score: 0.66, quota_score: 0.72, intelligence_score: 0.82, score: 0.79 },
  { provider: 'anthropic', provider_name: 'Anthropic', model: 'claude-sonnet-5.5', model_name: 'Claude Sonnet 5.5', effective_tps: 68, price_score: 0.55, speed_score: 0.56, quota_score: 0.61, intelligence_score: 0.92, score: 0.66 },
];

/* ------------------------------------------------------------------ */
/* Preferences                                                         */
/* ------------------------------------------------------------------ */

let preferences: DesktopPreferences = {
  general: { startupPage: 'last', openAtLogin: false, menuBarQuota: false },
  appearance: { theme: 'paper', colorMode: 'light', motion: 'system', zoom: 100 },
  session: { sendKey: 'enter', promptCompletion: true },
  notifications: { enabled: true },
  statusBar: { hidden: [] },
  update: { autoCheck: true },
};

function clonePreferences(value: DesktopPreferences): DesktopPreferences {
  return JSON.parse(JSON.stringify(value)) as DesktopPreferences;
}

function applyPreference(current: DesktopPreferences, id: PreferenceId, value: unknown): DesktopPreferences {
  const next = clonePreferences(current) as unknown as Record<string, unknown>;
  const parts = id.split('.');
  let cursor: Record<string, unknown> = next;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const child = cursor[parts[index]];
    if (typeof child !== 'object' || child === null) return current;
    cursor = child as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
  return next as unknown as DesktopPreferences;
}

/* ------------------------------------------------------------------ */
/* Bot agents                                                          */
/* ------------------------------------------------------------------ */

const AGENT_BOTS: AgentBot[] = [
  {
    id: 'reviewer',
    name: '巡检员',
    enabled: true,
    status: 'idle',
    configPath: '~/.config/wrenyard/bot-agents/reviewer.json',
    tools: ['session', 'todo', 'message'],
    lastWakeAt: iso(NOW - 12 * MINUTE),
    queued: 0,
    sessionId: 'bot-reviewer',
  },
  {
    id: 'release',
    name: '发布助手',
    enabled: true,
    status: 'running',
    configPath: '~/.config/wrenyard/bot-agents/release.json',
    tools: ['session', 'message'],
    lastWakeAt: iso(NOW - 40 * SECOND),
    queued: 1,
    sessionId: 'bot-release',
  },
];

const AGENT_CONFIGS: Record<string, string> = {
  reviewer: JSON.stringify({
    id: 'reviewer',
    name: '巡检员',
    instructions: '每天早上检查 aurora 的未完成待办，为需要动手的条目开会话处理，并把结果汇总给发布助手。',
    tools: { session: true, todo: true, message: true },
    routines: [{ name: 'morning-review', prompt: '检查 aurora 的未完成待办', intervalMinutes: 1440, deliver: 'bot:release' }],
  }, null, 2),
  release: JSON.stringify({
    id: 'release',
    name: '发布助手',
    instructions: '汇总收到的结果，起草发布说明。',
    tools: { session: true, message: true },
  }, null, 2),
};

const ROUTINES: Routine[] = [
  {
    id: 'a1b2c3d4',
    botId: 'reviewer',
    name: 'morning-review',
    prompt: '检查 aurora 的未完成待办',
    intervalMinutes: 1440,
    recurring: true,
    state: 'active',
    deliver: 'bot:release',
    createdAt: iso(NOW - 9 * DAY),
    nextRunAt: iso(NOW + 20 * HOUR),
    lastRunAt: iso(NOW - 4 * HOUR),
    runCount: 9,
  },
  {
    id: 'e5f6a7b8',
    botId: 'reviewer',
    prompt: '确认 billing 重试的 PR 已经通过评审',
    intervalMinutes: 120,
    recurring: false,
    state: 'paused',
    deliver: 'none',
    createdAt: iso(NOW - DAY),
    runCount: 0,
  },
];

/** The reviewer bot's context ledger: one routine round that opened a session. */
function buildAgentEvents(): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const push = (secondsAgo: number, draft: LedgerEventDraft): void => {
    events.push({ ...draft, seq: events.length + 1, at: iso(NOW - secondsAgo * SECOND) } as LedgerEvent);
  };
  const prompt = '例行任务 morning-review：检查 aurora 的未完成待办';
  const reasoning = '有 1 条待办需要改代码：billing 重试改为指数退避。我为它开一个会话处理，完成后把结果投递给发布助手。';
  const reply = '今天 aurora 有 3 条未完成待办：1 条已开会话处理（billing 重试改为指数退避），2 条在等外部评审。结果已投递给发布助手。';
  push(14_400, { type: 'turn.started', turn: 1, id: 't1', text: prompt, model: { provider: 'kimi-coding', model: 'kimi-k3', reasoningEffort: 'high' } });
  push(14_399, { type: 'step.started', id: 't1.1', parent: 't1', turn: 1, step: 1, model: 'kimi-coding/kimi-k3' });
  push(14_390, { type: 'reasoning.completed', turn: 1, step: 1, parent: 's1.1', text: reasoning });
  push(14_390, { type: 'action.started', turn: 1, step: 1, id: 'a1', parent: 't1.1', action: { type: 'tool', prompt: 'todo {"op":"list"}' } });
  push(14_389, { type: 'action.titled', turn: 1, step: 1, id: 'a1', title: '读取 aurora 待办' });
  push(14_388, { type: 'action.finished', turn: 1, step: 1, id: 'a1', action: { type: 'tool' }, status: 'done', result: '3 条未完成待办。' });
  push(14_388, { type: 'action.started', turn: 1, step: 1, id: 'a2', parent: 't1.1', action: { type: 'tool', prompt: 'session {"op":"create","text":"在 aurora 把 billing 重试改为指数退避并补齐测试"}' } });
  push(14_387, { type: 'action.titled', turn: 1, step: 1, id: 'a2', title: '开会话处理 billing 重试' });
  push(14_386, { type: 'action.finished', turn: 1, step: 1, id: 'a2', action: { type: 'tool' }, status: 'done', result: '已创建会话 demo-aurora-billing-retry。' });
  push(14_385, { type: 'step.finished', turn: 1, step: 1, id: 't1.1', status: 'done' });
  push(14_384, { type: 'reply.sent', turn: 1, step: 1, text: reply, kind: 'final' });
  push(14_384, { type: 'turn.finished', turn: 1, id: 't1', status: 'completed' });
  return events;
}

/* ------------------------------------------------------------------ */
/* Runtime and machine facts                                           */
/* ------------------------------------------------------------------ */

const GATEWAY_SETTINGS = {
  savedPortMode: 'fixed' as const,
  savedPort: 47120,
  tokenSaved: true,
  portChangePending: false,
  tokenChangePending: false,
  effective: {
    host: '127.0.0.1',
    port: 47120,
    openaiChatBaseUrl: 'http://127.0.0.1:47120/gateway/openai/v1',
    openaiResponsesBaseUrl: 'http://127.0.0.1:47120/gateway/openai/v1',
    anthropicBaseUrl: 'http://127.0.0.1:47120/gateway/anthropic',
    token: 'wy_demo_0000000000000000',
  },
};

const STORAGE_USAGE: StorageUsageSnapshot = {
  device: { hostname: DEVICE_NAME, platform: 'darwin' },
  roots: [
    { kind: 'state', path: '~/.local/state/wrenyard' },
    { kind: 'config', path: '~/.config/wrenyard' },
  ],
  status: 'ready',
  startedAt: iso(NOW - 3 * MINUTE),
  scannedAt: iso(NOW - 3 * MINUTE + 4 * SECOND),
  result: {
    totalBytes: 3_420_000_000,
    fileCount: 18_420,
    categories: [
      { id: 'sessions', bytes: 410_000_000, fileCount: 1_240, unreadable: 0 },
      { id: 'records', bytes: 280_000_000, fileCount: 3_900, unreadable: 0 },
      { id: 'files', bytes: 620_000_000, fileCount: 2_100, unreadable: 0 },
      { id: 'worktrees', bytes: 1_540_000_000, fileCount: 9_800, unreadable: 0 },
      { id: 'logs', bytes: 96_000_000, fileCount: 640, unreadable: 0 },
      { id: 'clients', bytes: 420_000_000, fileCount: 700, unreadable: 0 },
      { id: 'other', bytes: 54_000_000, fileCount: 40, unreadable: 0 },
    ],
    unreadable: 0,
    unreadableSamples: [],
    skippedLinks: 0,
  },
};

const OPERATION_COMPONENTS: OperationComponentSnapshot[] = [
  {
    id: 'browser',
    name: 'agent-browser',
    state: 'ready',
    source: 'managed',
    version: '0.9.2',
    pinnedVersion: '0.9.2',
    host: DEVICE_NAME,
    platform: 'darwin',
    arch: 'arm64',
    checkedAt: iso(NOW - 6 * MINUTE),
    hints: [],
    actions: ['refresh', 'repair', 'disable'],
  },
  {
    id: 'desktop',
    name: 'Cua Driver',
    state: 'ready',
    source: 'managed',
    version: '0.3.1',
    pinnedVersion: '0.3.1',
    host: DEVICE_NAME,
    platform: 'darwin',
    arch: 'arm64',
    checkedAt: iso(NOW - 6 * MINUTE),
    hints: [],
    actions: ['refresh', 'repair', 'disable'],
  },
];

const REMOTE_CONNECTION: RemoteConnectionSnapshot = { state: 'local', generation: 1, host: null };

/* ------------------------------------------------------------------ */
/* Workspace todos (synthetic, in-memory)                              */
/* ------------------------------------------------------------------ */

/** Synthetic read-only sample todos for the showcase todo page. */
const demoTodos: Todo[] = [
  {
    id: 'a1b2c3d4',
    title: '整理待办页面的折叠状态',
    status: 'in_progress',
    project: 'wrenyard',
    depends_on: [],
    created: iso(NOW - 3 * DAY),
    updated: iso(NOW - 20 * MINUTE),
    request: '为每个项目分区记住折叠状态。\n\n- 使用 `localStorage`\n- 存储不可用时页面照常工作',
    acceptance: '刷新后折叠状态保持不变。',
    attachments: [],
    resultSummary: '分区折叠状态持久化完成。',
  },
  {
    id: 'e5f6a7b8',
    title: '补充搜索高亮',
    status: 'in_progress',
    project: 'wrenyard',
    depends_on: [],
    created: iso(NOW - 2 * DAY),
    updated: iso(NOW - 2 * HOUR),
    request: '在标题中高亮匹配的文本。\n\n<!-- things-sync -->',
    acceptance: '匹配片段使用 `<mark>` 高亮。',
    attachments: [],
  },
  {
    id: '11223344',
    title: '阅读只读页面的验收清单',
    status: 'open',
    project: 'wrenyard',
    depends_on: ['a1b2c3d4'],
    created: iso(NOW - DAY),
    updated: iso(NOW - 26 * HOUR),
    request: '逐条核对验收清单并记录结果。',
    acceptance: '',
    attachments: [],
  },
  {
    id: '55667788',
    title: '记录一次性能采样',
    status: 'open',
    project: 'demo',
    depends_on: [],
    created: iso(NOW - 5 * DAY),
    updated: iso(NOW - 3 * DAY),
    request: '在普通数据量下采样一次首屏时间。',
    acceptance: '',
    attachments: [],
  },
  {
    id: '99aabbcc',
    title: '设计稿评审',
    status: 'open',
    depends_on: [],
    created: iso(NOW - 6 * DAY),
    updated: iso(NOW - 4 * DAY),
    request: '评审完成后同步结论。',
    acceptance: '',
    attachments: [],
  },
  {
    id: 'ddeeff00',
    title: '收尾折叠动画',
    status: 'done',
    project: 'wrenyard',
    depends_on: [],
    created: iso(NOW - 8 * DAY),
    updated: iso(NOW - DAY),
    request: '动画时长控制在 150ms 以内。',
    acceptance: '',
    attachments: [],
    resultSummary: '已使用 `Collapsible` 的高度过渡。',
  },
  {
    id: '0a1b2c3d',
    title: '移除旧版列表',
    status: 'cancelled',
    project: 'demo',
    depends_on: [],
    created: iso(NOW - 9 * DAY),
    updated: iso(NOW - 2 * DAY),
    request: '旧版列表不再维护。',
    acceptance: '',
    attachments: [],
  },
];

/* ------------------------------------------------------------------ */
/* Exec (in-memory, non-persistent)                                    */
/* ------------------------------------------------------------------ */

const executions = new Map<string, ExecSnapshotDto>();
let nextExecId = 1;

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createDemoShell(control?: DemoControl): DemoShell {
  function setPage(page: ShellPage): void {
    viewChanged.emit(page);
    control?.emitView(page);
  }

  function setAppearance(appearance: DemoAppearanceInput): void {
    const theme = appearance.theme === 'neutral' ? 'neutral' : 'paper';
    appearanceSettings = {
      ...appearanceSettings,
      theme,
      colorMode: appearance.dark ? 'dark' : 'light',
      motion: appearance.reduceMotion === true ? 'reduce' : 'system',
    };
    resolvedAppearance = {
      theme,
      dark: appearance.dark,
      reduceMotion: appearance.reduceMotion === true,
    };
    appearanceChanged.emit(resolvedAppearance);
  }

  const api: WrenyardShellApi = {
    platform: 'darwin',
    initialAppearance: INITIAL_APPEARANCE,

    getAppearance: async () => resolvedAppearance,
    onAppearanceChanged: (listener) => appearanceChanged.subscribe(listener),

    navigate: async (page) => {
      setPage(page);
    },
    showAppMenu: async () => undefined,
    onWindowStateChanged: () => () => undefined,

    getSettings: async () => buildSettings(),
    openMiniCard: async () => undefined,
    restoreMain: async () => undefined,
    setAlwaysOnTop: async () => undefined,
    closeWindow: async () => undefined,
    getGatewaySettings: async () => GATEWAY_SETTINGS,
    saveGatewaySettings: async () => ({ ...GATEWAY_SETTINGS, ok: true }),
    getStorageUsage: async () => STORAGE_USAGE,
    bot: async () => {
      throw new Error('The legacy bot is not part of the showcase.');
    },
    todo: async () => ({ todos: demoTodos }),
    botTodo: (async () => {
      throw new Error('Bot todo mutations are not part of the showcase.');
    }) as WrenyardShellApi['botTodo'],
    agent: (async (method: string, params?: { id?: string; botId?: string; afterSeq?: number }) => {
      switch (method) {
        case 'agent.list':
          return { bots: AGENT_BOTS };
        case 'agent.get': {
          const bot = AGENT_BOTS.find((entry) => entry.id === params?.id) ?? AGENT_BOTS[0]!;
          return { bot, config: AGENT_CONFIGS[bot.id] ?? '{}' };
        }
        case 'agent.events': {
          const events = params?.id === 'reviewer' ? buildAgentEvents() : [];
          const fresh = events.filter((event) => event.seq > (params?.afterSeq ?? 0));
          return { events: fresh, lastSeq: events.length };
        }
        case 'agent.wake':
          return { queued: 1 };
        case 'routine.list':
          return { routines: ROUTINES.filter((routine) => routine.botId === params?.botId) };
        default:
          return { routine: ROUTINES[0]!, deleted: true };
      }
    }) as WrenyardShellApi['agent'],
    getRemoteConnection: async () => REMOTE_CONNECTION,
    listRemoteHosts: async () => ({ hosts: [{ alias: 'build-box', displayName: '构建机', address: '10.0.0.12', os: 'linux' }] }),
    listDiscoveredSshHosts: async () => ({ hosts: [] }),
    testRemoteConnection: async () => ({ ok: true, platform: 'linux', arch: 'x64' }),
    confirmRemoteConnection: async () => ({ ok: true }),
    renameRemoteHost: async () => ({ ok: true }),
    connectSavedRemoteHost: async () => ({ ok: true }),
    returnToLocal: async () => ({ ok: true }),
    onRemoteChanged: () => () => undefined,
    getOperationComponents: async () => OPERATION_COMPONENTS,
    runOperationComponentAction: async (id) => OPERATION_COMPONENTS.find((component) => component.id === id)!,
    getStats: async () => STATS,
    getQuota: async () => buildQuota(),
    saveProviderOrder: async (providerIds) => {
      const seen = new Set<string>();
      const ordered: string[] = [];
      for (const id of providerIds) {
        if (!seen.has(id)) {
          seen.add(id);
          ordered.push(id);
        }
      }
      for (const id of PROVIDER_IDS) {
        if (!seen.has(id)) {
          seen.add(id);
          ordered.push(id);
        }
      }
      providerOrderIds = ordered;
      quotaChanged.emit();
      return buildQuota();
    },
    configureProviderKey: async () => buildQuota(),
    openProviderKeyPage: async () => undefined,

    getUpdate: async () => updateSnapshot,
    checkUpdate: async () => {
      updateSnapshot = { ...updateSnapshot, state: 'up-to-date', checkedAt: Date.now() };
      updateChanged.emit();
      return updateSnapshot;
    },
    requestInstall: async () => updateSnapshot,

    getDaemon: async () => daemonSnapshot,
    startDaemon: async () => {
      daemonSnapshot = { ...daemonSnapshot, state: 'running', canStart: true };
      daemonChanged.emit();
      return daemonSnapshot;
    },
    restartDaemon: async () => {
      daemonSnapshot = { ...daemonSnapshot, state: 'running', restartCount: daemonSnapshot.restartCount + 1 };
      daemonChanged.emit();
      return daemonSnapshot;
    },
    onDaemonChanged: (listener) => daemonChanged.subscribe(listener),

    getActivityStatus: async () => ACTIVITY,
    onActivityChanged: (listener) => activityChanged.subscribe(listener),

    savePetSettings: async (settings) => {
      petSettings = settings;
      return buildSettings();
    },
    saveWorkspace: async (path) => {
      workspaceSnapshot = {
        status: 'configured',
        source: 'user-config',
        configPath: '~/.config/wrenyard/workspace.json',
        path,
        readOnly: false,
      };
      return workspaceSnapshot;
    },

    openTaskTranscript: async () => undefined,
    openTaskGraph: async () => undefined,
    copyText: async () => undefined,
    openExternal: async () => undefined,

    onQuotaChanged: (listener) => quotaChanged.subscribe(listener),
    onUpdateChanged: (listener) => updateChanged.subscribe(listener),
    onViewChanged: (listener) => viewChanged.subscribe(listener),

    getTaskSettings: async () => TASK_SETTINGS,
    saveTaskSettings: async () => TASK_SETTINGS,
    requestTaskRoutingTest: async (): Promise<TaskRoutingTestResult> => ({
      rows: ROUTING_CANDIDATES.map((candidate, index) => ({
        ...candidate,
        rank: index + 1,
        reason: index < 3 ? null : '综合评分低于当前选择阈值',
      })),
    }),
    requestRoutingTestTasks: async (): Promise<TaskRoutingTestTasksResult> => ({ tasks: ROUTING_TASKS }),

    execStart: async (request) => {
      const id = `exec-${nextExecId}`;
      nextExecId += 1;
      const snapshot: ExecSnapshotDto = {
        id,
        client: request.client,
        status: 'running',
        createdAt: Date.now(),
      };
      executions.set(id, snapshot);
      return snapshot;
    },
    execGet: async (id) => {
      const existing = executions.get(id);
      if (existing !== undefined) return existing;
      const snapshot: ExecSnapshotDto = {
        id,
        client: 'codex',
        status: 'completed',
        createdAt: NOW - 2 * MINUTE,
        finishedAt: NOW - 30 * SECOND,
        exitCode: 0,
      };
      executions.set(id, snapshot);
      return snapshot;
    },
    execEvents: async (request): Promise<ExecEventsResult> => ({ events: [], nextSeq: request.afterSeq ?? 0 }),
    execCancel: async (id) => {
      const existing = executions.get(id);
      if (existing !== undefined) executions.set(id, { ...existing, status: 'cancelled' });
      return { id, status: 'cancelled' };
    },

    onNotificationShow: (listener) => notificationShow.subscribe(listener),
    onNotificationsChanged: (listener) => notificationsChanged.subscribe(listener),
    getNotificationSnapshot: async () => snapshotNotifications(),
    dismissNotification: async (id) => {
      notificationEntries = notificationEntries.filter((entry) => entry.id !== id);
      notificationsChanged.emit();
    },
    clearNotifications: async () => {
      notificationEntries = [];
      notificationsChanged.emit();
    },
    markNotificationsRead: async () => {
      notificationEntries = notificationEntries.map((entry) => (entry.read ? entry : { ...entry, read: true }));
      notificationsChanged.emit();
    },
    onCommandAction: () => () => undefined,

    getPreferences: async () => preferences,
    setPreference: async (id, value) => {
      if (!isPreferenceId(id) || !validatePreferenceValue(id, value)) return preferences;
      preferences = applyPreference(preferences, id, value);
      preferencesChanged.emit(preferences);
      // Mirror the main process: appearance preferences re-resolve and push
      // the appearance to the renderer.
      if (id === 'appearance.theme' || id === 'appearance.colorMode') {
        const { theme, colorMode } = preferences.appearance;
        setAppearance({ theme, dark: colorMode === 'dark' || (colorMode === 'system' && resolvedAppearance.dark) });
      }
      return preferences;
    },
    onPreferencesChanged: (listener) => preferencesChanged.subscribe(listener),

    openSettingsFile: async () => undefined,
    openLogsDirectory: async () => undefined,
    revealWorkspace: async () => undefined,
  };

  return { api, setPage, setAppearance, emitView: setPage };
}
