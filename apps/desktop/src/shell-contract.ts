import type {
  AppConfig,
  EntityVisibilityConfig,
  PetSettingsPayload,
  QuotaProviderEntry,
  WindowGeometry,
} from './pet/main/config';
import { BUILTIN_THEMES, type ThemeId } from '@wrenyard/themes';
import type {
  NotificationAction,
  NotificationCommandAction,
  NotificationInput,
  NotificationLevel,
  NotificationSnapshot,
  NotificationSource,
  ShellNotification,
} from './main/notification-center';
import type {
  ContextInspection,
  ContextItem,
  ContextItemKind,
  ContextLayerId,
  SummarySettingsSnapshot,
} from '@wrenyard/session';

// The Pet module keeps its public DTOs under `src/pet`. Desktop code outside
// that module reads the text of the contract here (types) and the runtime
// values from `pet/main/controller`, so no consumer reaches into Pet internals.
export type {
  AppConfig,
  EntityVisibilityConfig,
  PetSettingsPayload,
  QuotaProviderEntry,
  WindowGeometry,
};
export type {
  QuotaBarRow,
  QuotaProviderState,
  QuotaProviderStatus,
  QuotaTipLine,
  QuotaWindowRow,
} from './pet/shared/entities';
export { normalizeConfig } from './pet/main/config';
export type { DailyStatsSnapshot } from './pet/shared/snapshot';
export type { ActivityPresence } from './pet/shared/activity-snapshot';

// The summary-settings and context-inspection DTOs are owned by the session
// feature. Desktop re-exports them here so existing Desktop consumers keep one
// import site.
export type { ContextInspection, ContextItem, ContextItemKind, ContextLayerId, SummarySettingsSnapshot };

// The notification-center DTOs own the notification wire shape; the shell
// contract re-exports them so the preload facade, main handlers and renderer
// all read one definition.
export type {
  NotificationAction,
  NotificationCommandAction,
  NotificationInput,
  NotificationLevel,
  NotificationSnapshot,
  NotificationSource,
  ShellNotification,
};

/**
 * Whether a workspace is usable, plus where the configuration came from. A
 * snapshot never carries a credential; `readOnly` marks a configuration the
 * product itself may not rewrite.
 */
export interface WorkspaceConfigurationSnapshot {
  status: 'configured' | 'missing' | 'invalid';
  source: 'environment' | 'user-config' | 'none';
  configPath: string;
  path?: string;
  message?: string;
  readOnly: boolean;
}

/**
 * Selection-time speed evidence from the resolved speed contract. This is the
 * estimate chosen before the run started; it is distinct from the actual
 * measured `usage.outputTps` captured after the run completed.
 */
export interface TaskRunSpeedEvidence {
  /** Selection-time expected throughput (tokens per second). */
  effectiveTps: number;
  /** Where the selection estimate came from. Invalid evidence is omitted as a whole. */
  source: 'local_31d' | 'provider_override' | 'catalog_default';
  /** Number of local samples behind the selection estimate, when known. */
  sampleCount: number | null;
  /** Whether actual throughput is expected to meet the selection estimate, when known. */
  expectedTpsMet: boolean | null;
  /** Reason the selection estimate is considered degraded, when known. */
  degradationReason?: string;
}

/**
 * Per-run usage projection. Completeness reflects the CORE `reference_cost_complete`
 * flag: only `true` marks a run fully costed. Partial runs keep unknown optional
 * numbers absent rather than substituting zero; `unavailable` runs carry identity
 * only. `referenceCostUsd` is an estimate, never a billed amount.
 */
export interface TaskRunUsage {
  completeness: 'complete' | 'partial' | 'unavailable';
  attemptCount: number;
  usageEventCount: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  generationMs?: number;
  outputTps?: number;
  tpsContract?: 'tokenizer_v1';
  /** Estimated reference cost in USD. Absent (`undefined`) when CORE omits the numeric; never a fabricated value. */
  referenceCostUsd?: number;
  /** True when CORE fully costed this run; partial runs omit the cost. */
  referenceCostComplete: boolean;
  referenceCostBasis?: string;
}

/** A single recent Task run, projected from CORE's frozen TaskRunOutputResult metadata. */
export interface TaskRunSnapshot {
  taskRunId: string;
  taskId: string;
  taskName?: string;
  source?: 'builtin' | 'project' | 'unknown';
  /** Exact persisted execution project; present only when nonblank. */
  project?: string;
  status?: 'done' | 'failed' | 'cancelled' | 'interrupted' | 'running' | 'queued';
  startedAt?: string;
  finishedAt?: string;
  resolvedClient?: string;
  resolvedProvider?: string;
  resolvedProfile?: string;
  resolvedModel?: string;
  resolvedModelId?: string;
  /** Paired Catalog provider display label; present only when the run row carries both labels. */
  resolvedProviderDisplayName?: string;
  /** Paired Catalog model display label; present only when the run row carries both labels. */
  resolvedModelDisplayName?: string;
  speed?: TaskRunSpeedEvidence;
  usage: TaskRunUsage;
}

export const ACTIVITY_BAR_WIDTH = 48;

export const SHELL_CHANNELS = {
  navigate: 'wrenyard-shell:navigate',
  showAppMenu: 'wrenyard-shell:show-app-menu',
  windowStateChanged: 'wrenyard-shell:window-state-changed',
  appearanceSnapshot: 'wrenyard-shell:appearance-snapshot',
  appearanceChanged: 'wrenyard-shell:appearance-changed',
  settingsSnapshot: 'wrenyard-shell:settings-snapshot',
  statsSnapshot: 'wrenyard-shell:stats-snapshot',
  quotaSnapshot: 'wrenyard-shell:quota-snapshot',
  saveProviderOrder: 'wrenyard-shell:save-provider-order',
  savePetSettings: 'wrenyard-shell:save-pet-settings',
  saveWorkspace: 'wrenyard-shell:save-workspace',
  taskTranscript: 'wrenyard-shell:task-transcript',
  taskGraph: 'wrenyard-shell:task-graph',
  copyText: 'wrenyard-shell:copy-text',
  openExternal: 'wrenyard-shell:open-external',
  configureProviderKey: 'wrenyard-shell:configure-provider-key',
  openProviderKeyPage: 'wrenyard-shell:open-provider-key-page',
  updateSnapshot: 'wrenyard-shell:update-snapshot',
  checkUpdate: 'wrenyard-shell:check-update',
  requestInstall: 'wrenyard-shell:request-install',
  daemonSnapshot: 'wrenyard-shell:daemon-snapshot',
  daemonStart: 'wrenyard-shell:daemon-start',
  daemonRestart: 'wrenyard-shell:daemon-restart',
  activityStatusSnapshot: 'wrenyard-shell:activity-status-snapshot',
  quotaChanged: 'wrenyard-shell:quota-changed',
  updateChanged: 'wrenyard-shell:update-changed',
  daemonChanged: 'wrenyard-shell:daemon-changed',
  activityChanged: 'wrenyard-shell:activity-changed',
  viewChanged: 'wrenyard-shell:view-changed',
  notificationsSnapshot: 'wrenyard-shell:notifications-snapshot',
  notificationNotify: 'wrenyard-shell:notification-notify',
  notificationDismiss: 'wrenyard-shell:notification-dismiss',
  notificationsClear: 'wrenyard-shell:notifications-clear',
  notificationsMarkRead: 'wrenyard-shell:notifications-mark-read',
  notificationsSetDoNotDisturb: 'wrenyard-shell:notifications-set-do-not-disturb',
  notificationsChanged: 'wrenyard-shell:notifications-changed',
  commandAction: 'wrenyard-shell:command-action',
  taskSettingsSnapshot: 'wrenyard-shell:task-settings-snapshot',
  taskSettingsSave: 'wrenyard-shell:task-settings-save',
  runtimeAliasSnapshot: 'wrenyard-shell:runtime-alias-snapshot',
  runtimeAliasPut: 'wrenyard-shell:runtime-alias-put',
  runtimeAliasRemove: 'wrenyard-shell:runtime-alias-remove',
  taskRoutingTest: 'wrenyard-shell:task-routing-test',
  taskRoutingTestTasks: 'wrenyard-shell:task-routing-test-tasks',
  summaryModelSnapshot: 'wrenyard-shell:summary-model-snapshot',
  summaryModelSave: 'wrenyard-shell:summary-model-save',
  execStart: 'wrenyard-shell:exec-start',
  execGet: 'wrenyard-shell:exec-get',
  execEvents: 'wrenyard-shell:exec-events',
  execCancel: 'wrenyard-shell:exec-cancel',
  preferencesSnapshot: 'wrenyard-shell:preferences-snapshot',
  setPreference: 'wrenyard-shell:set-preference',
  preferencesChanged: 'wrenyard-shell:preferences-changed',
  openSettingsFile: 'wrenyard-shell:open-settings-file',
  openLogsDirectory: 'wrenyard-shell:open-logs-directory',
  revealWorkspace: 'wrenyard-shell:reveal-workspace',
} as const;

export type ShellPage = 'session' | 'stats' | 'quota' | 'settings' | 'tasks';

/* ------------------------------------------------------------------ */
/* Appearance                                                          */
/* ------------------------------------------------------------------ */

/** How the appearance prefers its light/dark rendering. */
export type ColorMode = 'system' | 'light' | 'dark';

/** Whether motion follows the OS setting or is unconditionally reduced. */
export type MotionPreference = 'system' | 'reduce';

/**
 * Persisted appearance preferences. Stored in the Desktop main-process
 * settings document (version 3), replacing the renderer localStorage scheme.
 * `theme` is a theme-registry id; Desktop never hardcodes the list. `zoom` is
 * the persisted interface zoom percentage, applied on the next launch.
 */
export interface AppearanceSettings {
  theme: ThemeId;
  colorMode: ColorMode;
  motion: MotionPreference;
  /** Interface zoom as a percentage (see the appearance zoom option bounds). */
  zoom: number;
}

/**
 * The main process resolves {@link AppearanceSettings} against the OS into
 * concrete values every surface can render without re-deriving them.
 */
export interface ResolvedAppearance {
  theme: ThemeId;
  /** Resolved dark rendering: the selected mode, or the OS preference. */
  dark: boolean;
  /** Resolved reduced motion: the preference, or the OS reduced-motion setting. */
  reduceMotion: boolean;
}

/** Window chrome state pushed by the main process (macOS fullscreen inset). */
export interface WindowStateSnapshot {
  fullscreen: boolean;
}

/** Renderer-supplied popup anchor for the Windows application menu button. */
export interface AppMenuPosition {
  x: number;
  y: number;
}

/* ------------------------------------------------------------------ */
/* Desktop preferences (settings schema version 3)                     */
/* ------------------------------------------------------------------ */

/** Which page the shell opens after launch. */
export type StartupPagePreference = 'last' | 'session';

/** The message-submit key binding for the prompt input. */
export type SessionSendKey = 'enter' | 'mod-enter';

/** Allowed interface zoom percentages (80%–150%, step 10%). */
export const APPEARANCE_ZOOM_MIN = 80;
export const APPEARANCE_ZOOM_MAX = 150;
export const APPEARANCE_ZOOM_STEP = 10;

export const APPEARANCE_ZOOM_OPTIONS: ReadonlyArray<{ value: number; label: string }> =
  Array.from(
    { length: (APPEARANCE_ZOOM_MAX - APPEARANCE_ZOOM_MIN) / APPEARANCE_ZOOM_STEP + 1 },
    (_unused, index) => {
      const value = APPEARANCE_ZOOM_MIN + index * APPEARANCE_ZOOM_STEP;
      return { value, label: `${value}%` };
    },
  );

export const STARTUP_PAGE_OPTIONS: ReadonlyArray<{ value: StartupPagePreference; label: string }> = [
  { value: 'last', label: '上次的页面' },
  { value: 'session', label: '会话' },
];

export const SESSION_SEND_KEY_OPTIONS: ReadonlyArray<{ value: SessionSendKey; label: string }> = [
  { value: 'enter', label: 'Enter 发送' },
  { value: 'mod-enter', label: 'Cmd/Ctrl+Enter 发送' },
];

/** Stable notification event ids; the persisted keys of `notifications.events`. */
export const NOTIFICATION_EVENT_IDS = [
  'taskCompleted',
  'taskFailed',
  'sessionReplyCompleted',
  'quotaWarning',
  'updateAvailable',
  'daemonDisconnected',
] as const;
export type NotificationEventId = (typeof NOTIFICATION_EVENT_IDS)[number];

export const NOTIFICATION_EVENT_LABELS: Readonly<Record<NotificationEventId, string>> = {
  taskCompleted: '任务完成',
  taskFailed: '任务失败',
  sessionReplyCompleted: '会话回复完成',
  quotaWarning: '额度告警',
  updateAvailable: '有可用更新',
  daemonDisconnected: 'Daemon 断开',
};

/**
 * Per-event notification toggles. Each key gates one event family emitted by
 * the main process or the Pet module; a disabled family is never recorded nor
 * surfaced. Field names are the persisted contract, so they stay stable.
 */
export interface NotificationEventPreferences {
  taskCompleted: boolean;
  taskFailed: boolean;
  sessionReplyCompleted: boolean;
  quotaWarning: boolean;
  updateAvailable: boolean;
  daemonDisconnected: boolean;
}

/** Desktop notification preferences, including the runtime do-not-disturb flag. */
export interface NotificationPreferences {
  /** Whether OS-level notifications are enabled at all. */
  system: boolean;
  /** Whether OS notifications play a sound. */
  sound: boolean;
  /** Do-not-disturb: history only, except error-level notifications. */
  doNotDisturb: boolean;
  events: NotificationEventPreferences;
}

/** Persisted general partition fields. */
export interface GeneralPreferences {
  startupPage: StartupPagePreference;
  confirmQuit: boolean;
}

/**
 * Renderer view of the general preferences. `openAtLogin` mirrors the OS
 * login-item state and `menuBarQuota` mirrors the persisted `tray.showQuota`
 * flag; neither is stored a second time in the general partition.
 */
export interface GeneralPreferenceView extends GeneralPreferences {
  openAtLogin: boolean;
  menuBarQuota: boolean;
}

/**
 * Renderer-visible session preferences. The retired model-default and
 * last-sent memory keys are no longer part of the product surface: a new
 * session inherits the model and effort from the client-local first-request
 * record, so only the message-submit key remains here.
 */
export interface SessionPreferences {
  sendKey: SessionSendKey;
}

export interface StatusBarPreferences {
  /** Ids of status items the user chose to hide. */
  hidden: string[];
}

export interface UpdatePreferences {
  /** Whether Desktop checks for updates automatically; manual check always works. */
  autoCheck: boolean;
}

/**
 * The renderer-facing projection of the version 3 Desktop preference
 * partitions. The main process is the single writer; the bridge validates
 * every mutation against the shared schema before persisting.
 */
export interface DesktopPreferences {
  general: GeneralPreferenceView;
  appearance: AppearanceSettings;
  session: SessionPreferences;
  notifications: NotificationPreferences;
  statusBar: StatusBarPreferences;
  update: UpdatePreferences;
}

/** The Desktop preference partitions a preference path can address. */
export type PreferenceSection = 'general' | 'appearance' | 'session' | 'notifications' | 'statusBar' | 'update';

/** Path from a preference id to the value it addresses inside a preference document. */
export type PreferencePath =
  | readonly [PreferenceSection, string]
  | readonly ['notifications', 'events', string];

/** One preference: where its value lives and the single rule that validates it. */
export interface PreferenceDescriptor {
  readonly path: PreferencePath;
  validate(value: unknown): boolean;
}

/**
 * The partition shape addressed by preference paths. Both the renderer-facing
 * {@link DesktopPreferences} and the persisted `DesktopSettings` satisfy it, so
 * the same helpers read and write either document.
 */
export interface PreferenceDocument {
  general: object;
  appearance: object;
  session: object;
  notifications: object;
  statusBar: object;
  update: object;
}

const PREFERENCE_STRING_MAX = 512;
const PREFERENCE_STRING_ARRAY_MAX = 64;

const BUILTIN_THEME_IDS: ReadonlySet<string> = new Set(BUILTIN_THEMES.map((theme) => theme.id));

/**
 * The single descriptor table for every writable preference: each id names the
 * document path it addresses and the one validation rule for its value. Ids,
 * validation, reading and writing all derive from this table, so adding a
 * preference is one entry.
 */
export const PREFERENCES = {
  'general.startupPage': { path: ['general', 'startupPage'], validate: (value) => value === 'last' || value === 'session' },
  'general.confirmQuit': { path: ['general', 'confirmQuit'], validate: (value) => typeof value === 'boolean' },
  'general.openAtLogin': { path: ['general', 'openAtLogin'], validate: (value) => typeof value === 'boolean' },
  'general.menuBarQuota': { path: ['general', 'menuBarQuota'], validate: (value) => typeof value === 'boolean' },
  'appearance.theme': { path: ['appearance', 'theme'], validate: (value) => typeof value === 'string' && BUILTIN_THEME_IDS.has(value) },
  'appearance.colorMode': { path: ['appearance', 'colorMode'], validate: (value) => value === 'system' || value === 'light' || value === 'dark' },
  'appearance.motion': { path: ['appearance', 'motion'], validate: (value) => value === 'system' || value === 'reduce' },
  'appearance.zoom': {
    path: ['appearance', 'zoom'],
    validate: (value) => typeof value === 'number' && APPEARANCE_ZOOM_OPTIONS.some((option) => option.value === value),
  },
  'session.sendKey': { path: ['session', 'sendKey'], validate: (value) => value === 'enter' || value === 'mod-enter' },
  'notifications.system': { path: ['notifications', 'system'], validate: (value) => typeof value === 'boolean' },
  'notifications.sound': { path: ['notifications', 'sound'], validate: (value) => typeof value === 'boolean' },
  'notifications.doNotDisturb': { path: ['notifications', 'doNotDisturb'], validate: (value) => typeof value === 'boolean' },
  'notifications.events.taskCompleted': { path: ['notifications', 'events', 'taskCompleted'], validate: (value) => typeof value === 'boolean' },
  'notifications.events.taskFailed': { path: ['notifications', 'events', 'taskFailed'], validate: (value) => typeof value === 'boolean' },
  'notifications.events.sessionReplyCompleted': { path: ['notifications', 'events', 'sessionReplyCompleted'], validate: (value) => typeof value === 'boolean' },
  'notifications.events.quotaWarning': { path: ['notifications', 'events', 'quotaWarning'], validate: (value) => typeof value === 'boolean' },
  'notifications.events.updateAvailable': { path: ['notifications', 'events', 'updateAvailable'], validate: (value) => typeof value === 'boolean' },
  'notifications.events.daemonDisconnected': { path: ['notifications', 'events', 'daemonDisconnected'], validate: (value) => typeof value === 'boolean' },
  'statusBar.hidden': {
    path: ['statusBar', 'hidden'],
    validate: (value) => Array.isArray(value)
      && value.length <= PREFERENCE_STRING_ARRAY_MAX
      && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= PREFERENCE_STRING_MAX),
  },
  'update.autoCheck': { path: ['update', 'autoCheck'], validate: (value) => typeof value === 'boolean' },
} as const satisfies Record<string, PreferenceDescriptor>;

/** Every writable preference id, addressable by the generic preference bridge. */
export type PreferenceId = keyof typeof PREFERENCES;

/** The ids in table order; the bridge validates untrusted ids against this set. */
export const PREFERENCE_IDS: readonly PreferenceId[] = Object.keys(PREFERENCES) as PreferenceId[];

export function isPreferenceId(value: unknown): value is PreferenceId {
  return typeof value === 'string' && (PREFERENCE_IDS as readonly string[]).includes(value);
}

/** Walks a preference's descriptor path in a document; a missing step is `undefined`. */
export function readPreferenceValue(preferences: PreferenceDocument, id: PreferenceId): unknown {
  let cursor: unknown = preferences;
  for (const key of PREFERENCES[id].path as readonly string[]) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * Immutable write of one preference: only the touched partition (and, for a
 * `notifications.events.*` id, the nested events object) is copied.
 */
export function writePreferenceValue<T extends PreferenceDocument>(
  preferences: T,
  id: PreferenceId,
  value: unknown,
): T {
  const path = PREFERENCES[id].path as readonly string[];
  const document = preferences as unknown as Record<string, Record<string, unknown>>;
  if (path.length === 3) {
    const section = path[0]!;
    const key = path[2]!;
    const container = document[section]!;
    const events = container.events as Record<string, unknown>;
    return {
      ...preferences,
      [section]: { ...container, events: { ...events, [key]: value } },
    } as T;
  }
  const section = path[0]!;
  const key = path[1]!;
  const container = document[section]!;
  return {
    ...preferences,
    [section]: { ...container, [key]: value },
  } as T;
}

/**
 * Central preference value validation. Both the main-process write path and
 * the renderer option lists derive from the one descriptor table, so an illegal
 * value can never be persisted and the two sides cannot drift.
 */
export function validatePreferenceValue(id: PreferenceId, value: unknown): boolean {
  return PREFERENCES[id].validate(value);
}

export interface ServiceSnapshot {
  status: 'connected' | 'unavailable';
  endpoint: string;
  workspace: WorkspaceConfigurationSnapshot;
  /** Runtime mode reported by the connected daemon's health projection. */
  runtimeMode?: 'source' | 'installed';
  uptimeMs?: number;
}export interface ModelSnapshot {
  id: string;
  label: string;
  configured: boolean;
}

/**
 * The simplified Desktop update surface. Desktop only checks and prompts; the
 * installed SEA engine performs the install and reports a durable result.
 */
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'waiting'
  | 'installing'
  | 'error';

/**
 * Why in-app installation is unavailable for the current installation. Kept in
 * sync with the updater's discovery so every surface explains the same cause.
 */
export type UpdateInstallReason =
  | 'unsupported-platform'
  | 'missing-cli'
  | 'missing-runtime'
  | 'source-development';

export interface UpdateSnapshot {
  state: UpdateState;
  currentVersion: string;
  availableVersion?: string;
  checkedAt?: number;
  installSupported: boolean;
  /** Present only while `installSupported` is false. */
  installReason?: UpdateInstallReason;
  message?: string;
}

/**
 * Who owns the daemon lifecycle. `supervised` means Desktop launched it, so it
 * stops it on quit; `connected` means it was started elsewhere (the CLI or the
 * source-development supervisor) and Desktop only disconnects.
 */
export type DaemonConnectionMode = 'supervised' | 'connected';

export type DaemonProcessState =
  | 'starting'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'unavailable';

/**
 * Simplied activity projection for the status bar (window-chrome spec 4.4). It
 * is a bounded projection of the shared `ActivityPresence` round: only the
 * queued/running task runs and the active task graphs, with the fields the
 * status bar renders. `stale` marks a failed round that re-published the last
 * complete snapshot so the UI can show （数据过期） instead of clearing.
 */
export interface ActivityStatusTask {
  taskRunId: string;
  status: 'queued' | 'running';
  taskId?: string;
  taskLabel?: string;
  project?: string;
  taskgraphId?: string;
  /** Task-run creation timestamp (ISO 8601); never fabricated from `sampledAt`. */
  startedAt: string;
}

export interface ActivityStatusTaskGraph {
  taskgraphId: string;
  title?: string;
  project?: string;
  state: string;
  nodeCounts: Record<string, number>;
}

export interface ActivityStatusSnapshot {
  sampledAt: string;
  stale: boolean;
  tasks: ActivityStatusTask[];
  taskgraphs: ActivityStatusTaskGraph[];
}

/** Live daemon lifecycle projection consumed by the Desktop surfaces. */
export interface DaemonLifecycleSnapshot {
  mode: DaemonConnectionMode;
  state: DaemonProcessState;
  /** Only a supervised Desktop may launch or restart the daemon. */
  canStart: boolean;
  restartCount: number;
  pid?: number;
  message?: string;
}

export interface SettingsSnapshot {
  service: ServiceSnapshot;
  models: ModelSnapshot[];
  pet: PetCompanionSnapshot;
  update: UpdateSnapshot;
  about: {
    desktopVersion: string;
    wrenyardVersion: string;
    buildTime?: string;
  };
}

export type PetCompanionSettings = PetSettingsPayload;

export interface PetDisplaySnapshot {
  id: number;
  label: string;
  isPrimary: boolean;
}

export interface PetCompanionSnapshot {
  settings: PetCompanionSettings;
  status: 'running' | 'stopped' | 'starting' | 'stopping' | 'failed';
  displays: PetDisplaySnapshot[];
}

export interface StatsOutcomesSnapshot {
  done: number;
  failed: number;
  cancelled: number;
  running?: number;
}

export interface StatsTodaySnapshot {
  dayKey: string;
  startAt: string;
  endAt: string;
  dispatchCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  outcomes?: StatsOutcomesSnapshot;
}

export interface StatsDailySnapshot {
  dayKey: string;
  dispatchCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  outcomes?: Omit<StatsOutcomesSnapshot, 'running'>;
}

export type StatsPeriod = '24h' | '7d' | '1mo';

export interface StatsWindowSnapshot {
  period: StatsPeriod;
  startAt: string;
  endAt: string;
  dispatchCount: number;
  totalTokens: number;
  totalDurationMs: number;
  builtinTotalDurationMs: number;
  byProfile: Array<{
    /** Canonical internal identity: a server `model` when provided, else the legacy `profile`. */
    name: string;
    /** Canonical model identity carried by newer payloads; absent on legacy profile-only rows. */
    model?: string;
    /** Exact unified Catalog model display label; absent when the server does not supply one. */
    modelDisplayName?: string;
    /** Exact Catalog provider display names backing this row, de-duplicated by the server. */
    providerDisplayNames?: string[];
    runCount: number;
    totalTokens: number;
    averageTps?: number;
  }>;
  byTask: Array<{
    name: string;
    source: 'builtin' | 'project' | 'unknown';
    runCount: number;
    durationMs: number;
    averageDurationMs: number;
  }>;
  byBuiltinTask: Array<{
    name: string;
    source: 'builtin' | 'project' | 'unknown';
    runCount: number;
    durationMs: number;
    averageDurationMs: number;
  }>;
}

export interface StatsSnapshot {
  status: 'available' | 'unavailable';
  today: StatsTodaySnapshot | null;
  daily: StatsDailySnapshot[];
  windows: StatsWindowSnapshot[];
  recentTaskRuns: TaskRunSnapshot[];
}

export interface QuotaWindowSnapshot {
  name: string;
  remainingPct: number;
  expectedRemainingPct: number | null;
  /** ISO 8601 reset time; omitted when invalid or already past. */
  resetsAt?: string;
  /** Window length in minutes; drives the Chinese window label. */
  windowMinutes?: number;
}

export interface QuotaBalanceSnapshot {
  currency: string;
  amount: string;
  display: string;
}

export interface QuotaProviderSnapshot {
  id: string;
  label: string;
  status: 'ok' | 'pending' | 'error' | 'unavailable';
  stale: boolean;
  windows: QuotaWindowSnapshot[];
  balances: QuotaBalanceSnapshot[];
  displayLine?: string;
  message?: string;
  code?: string;
}

export type ProviderAuthMode = 'api-key' | 'environment' | 'native' | 'none';

/** USD per million tokens: [cached, input, output]. */
export type ProviderModelPricingSnapshot = readonly [number, number, number];

/** Shared provider-model row for the Provider and Model List surfaces. */
export interface ProviderModelSnapshot {
  id: string;
  displayName: string;
  effectiveTps?: number | null;
  quotaAbundant?: boolean;
  /**
   * Authoritative catalog free-model flag. Only an explicit `true` marks a
   * model free; absence/`undefined` means unknown and must never be inferred
   * from a missing or zero price.
   */
  free?: boolean;
  /** Provider-independent canonical model id; falls back to the model id. */
  canonicalId?: string;
  /** Catalog intelligence tier for the model. */
  intelligence?: 'low' | 'mid' | 'high' | 'premium';
  /** Catalog list price as [cached, input, output] USD per million tokens. */
  pricing: ProviderModelPricingSnapshot;
  /** Which evidence tier produced `effectiveTps`. */
  speedSource?: 'local_31d' | 'provider_override' | 'catalog_default';
  /** True when a credential is configured AND the resolver admits provider/model. */
  available?: boolean;
}

export interface ProviderAuthStatus {
  id: string;
  displayName?: string;
  description?: string;
  setupHint?: string;
  configured: boolean;
  authMode: ProviderAuthMode;
  models?: ProviderModelSnapshot[];
}

export interface ProviderCatalogSnapshot {
  id: string;
  label: string;
  description: string;
  configured: boolean;
  authMode: ProviderAuthMode;
  setupHint: string;
  quota?: QuotaProviderSnapshot;
  models?: ProviderModelSnapshot[];
}

export interface ProviderOrderSnapshot {
  id: string;
  enabled: boolean;
}

export interface QuotaSnapshot {
  status: 'available' | 'unavailable';
  providers: QuotaProviderSnapshot[];
  catalog: ProviderCatalogSnapshot[];
  providerOrder: ProviderOrderSnapshot[];
  refreshedAt?: number;
  message?: string;
}

/**
 * Daemon task.settings projection. Settings are layered across system defaults,
 * daemon builtins, a machine-global user layer, a per-task user layer, and
 * one-shot invocation overrides. Desktop is only a transport/UI client — the
 * daemon owns merge, persistence, and preflight — so this contract mirrors the
 * snake_case wire DTOs from the Foreman task.settings protocol and never
 * re-implements merging. Readiness/merging/schema editing are daemon-owned.
 */

/** Which user layer a settings snapshot or save request targets. */
export type TaskSettingsScope = 'global' | 'task';

/** Runtime resolution mode a user layer may request. */
export type TaskSettingsMode = 'automatic' | 'explicit';

/**
 * Explicit-mode runtime selection: either a stored runtime alias name or an
 * inline canonical `provider/model:client` target. Desktop never synthesizes a
 * resolved client/provider/model triple and never enumerates catalog candidates.
 */
export type TaskSettingsExplicitReference =
  | { kind: 'alias'; name: string }
  | { kind: 'target'; target: string };

/** Automatic dispatch field enums (mirrors the task dispatch requirements). */
export type TaskSettingsIntelligence = 'low' | 'mid' | 'high' | 'premium';
export type TaskSettingsCapability = 'text' | 'image';

/** JSON-safe snake_case automatic dispatch constraints a user layer may set. */
export interface TaskSettingsAutomaticDispatch {
  expected_tps?: number;
  minimum_tps?: number;
  intelligence_min?: TaskSettingsIntelligence;
  intelligence_expected?: TaskSettingsIntelligence;
  max_output_usd_per_million?: number;
  required_capabilities?: readonly TaskSettingsCapability[];
  requires_web_search?: boolean;
  exclude_model_ids?: readonly string[];
  exclude_profile_ids?: readonly string[];
  exclude_client_ids?: readonly string[];
  exclude_provider_ids?: readonly string[];
}

export type TaskSettingsAutomaticPatch = {
  [K in keyof TaskSettingsAutomaticDispatch]?: TaskSettingsAutomaticDispatch[K] | null;
};

/** Source layer that supplied an effective settings field; higher index wins. */
export type TaskSettingsSourceLayer =
  | 'system'
  | 'builtin'
  | 'user_global'
  | 'user_task'
  | 'invocation';

/** An effective value plus the layer that provided it. */
export interface TaskSettingsSourcedValue<T> {
  value: T;
  source: TaskSettingsSourceLayer;
}

/**
 * Writable settings fields of a user layer. Absent fields fall through to the
 * lower layer; a `null` value clears an override back to the lower layer.
 */
export interface TaskSettingsRoutingWeights {
  price: number;
  speed: number;
  quota: number;
  intelligence: number;
}

export interface TaskSettingsLayer {
  mode?: TaskSettingsMode;
  explicit_runtime?: TaskSettingsExplicitReference | null;
  timeout_ms?: number | null;
  /** Global-only auto-dispatch reference output cap (USD / million output tokens). 0 is valid; null clears; absent falls through. */
  max_auto_output_usd_per_million?: number | null;
  routing_weights?: TaskSettingsRoutingWeights | null;
  automatic?: Partial<TaskSettingsAutomaticDispatch> | null;
}

/** Field-level save patch; `null` deletes that field only at the selected layer. */
export interface TaskSettingsPatch {
  mode?: TaskSettingsMode | null;
  explicit_runtime?: TaskSettingsExplicitReference | null;
  timeout_ms?: number | null;
  /** Global-only reference output cap; null deletes only this field at the selected layer. */
  max_auto_output_usd_per_million?: number | null;
  routing_weights?: TaskSettingsRoutingWeights | null;
  automatic?: TaskSettingsAutomaticPatch | null;
}

/** Effective automatic dispatch: every field carries its own source layer. */
export interface TaskSettingsEffectiveAutomatic {
  expected_tps: TaskSettingsSourcedValue<number | null>;
  minimum_tps: TaskSettingsSourcedValue<number | null>;
  intelligence_min: TaskSettingsSourcedValue<TaskSettingsIntelligence | null>;
  intelligence_expected?: TaskSettingsSourcedValue<TaskSettingsIntelligence | null>;
  max_output_usd_per_million: TaskSettingsSourcedValue<number | null>;
  required_capabilities: TaskSettingsSourcedValue<TaskSettingsCapability[] | null>;
  requires_web_search?: TaskSettingsSourcedValue<boolean | null>;
  exclude_model_ids: TaskSettingsSourcedValue<string[] | null>;
  exclude_profile_ids: TaskSettingsSourcedValue<string[] | null>;
  exclude_client_ids: TaskSettingsSourcedValue<string[] | null>;
  exclude_provider_ids: TaskSettingsSourcedValue<string[] | null>;
}

/** Effective settings of one task, each value tagged with its source layer. */
export interface TaskSettingsEffective {
  routing_weights?: TaskSettingsSourcedValue<TaskSettingsRoutingWeights | null>;
  mode: TaskSettingsSourcedValue<TaskSettingsMode>;
  explicit_runtime: TaskSettingsSourcedValue<TaskSettingsExplicitReference | null>;
  timeout_ms: TaskSettingsSourcedValue<number | null>;
  /** Global-only auto cap; effective per task carries its own source layer. */
  max_auto_output_usd_per_million: TaskSettingsSourcedValue<number | null>;
  automatic: TaskSettingsEffectiveAutomatic;
}

/** Structured automatic-resolution failure detail the daemon attaches to an issue. */
export interface TaskSettingsResolutionFailure {
  code: 'no_available_provider' | 'price_limit' | 'intelligence_requirement' | 'speed_requirement' | 'quota_unavailable' | 'quota_insufficient';
  message: string;
}

/** A validation problem surfaced by the daemon. */
export interface TaskSettingsValidationIssue {
  code: string;
  message: string;
  field?: string;
  /** Closed structured resolution failure; present only on resolution-failure issues. */
  resolutionFailure?: TaskSettingsResolutionFailure;
}

/** A daemon-owned resolved dispatch projection for an explicit reference. */
export interface TaskResolvedDispatch {
  /** Exact canonical resolved identity string. */
  runtime: string;
  client: string;
  provider: string;
  model: string;
  model_id?: string;
  profile?: string;
  /** Paired authoritative Catalog provider display label; present only when the daemon resolves both labels. */
  provider_display_name?: string;
  /** Paired authoritative unified Catalog model display label; present only when the daemon resolves both labels. */
  model_display_name?: string;
}

/**
 * One ordered, non-executing preview segment of a builtin prompt template. The
 * former user additional-instructions insertion slot was removed from the
 * surface, so no segment exposes an editing slot.
 */
export type TaskSettingsInstructionSegment =
  /** Static instruction text carried verbatim; renderers escape before display. */
  | { kind: 'text'; source: string; text: string }
  /** A non-executed function instruction or the input-dependent prompt body. */
  | { kind: 'placeholder'; source: string; label: string };

/** Ordered safe preview of the builtin prompt template; never executes config. */
export type TaskSettingsInstructionTemplate = TaskSettingsInstructionSegment[];

/** Read-only metadata about a daemon-builtin task. */
export interface TaskSettingsBuiltinMetadata {
  identity: string;
  name: string;
  source: string;
  description?: string;
  project?: string;
  prompt_template: 'dynamic' | 'fixed';
  instruction_template: TaskSettingsInstructionTemplate;
  timeout_ms: number | null;
  dispatch: TaskSettingsAutomaticDispatch;
}

/** Explicit-mode resolution data carried on a row by the daemon when resolved. */
export interface TaskSettingsExplicitRow {
  /** Daemon-resolved dispatch; null while unresolved/unavailable. */
  resolved: TaskResolvedDispatch | null;
}

/**
 * Automatic-mode resolution data carried on an automatic row by the daemon when
 * resolved. Mirrors the daemon automatic-selection row projection exactly: when
 * this object is present it is fully populated. Backward compatibility for older
 * snapshots and unresolved rows lives on the optional row-level field
 * `TaskSettingsTaskRow.automatic_selection`, which is omitted until the daemon
 * resolves.
 */
export interface TaskSettingsAutomaticSelection {
  /** Exact runtime reference (alias name or target) that produced the automatic selection. */
  exact_runtime: string;
  /** Daemon-resolved dispatch of the automatic selection. */
  resolved: TaskResolvedDispatch;
  /** Human-safe rationale text for the automatic selection. */
  reason: string;
}

/**
 * One layer of a Task definition's inheritance chain, ordered base→effective.
 * The final entry is the effective layer; earlier entries are the layers it
 * inherited from. Desktop renders this read-only and never edits it.
 */
export interface TaskDefinitionInheritanceLayer {
  source: 'builtin' | 'project';
  /** Registered project id; present only for project layers. */
  project?: string;
  /** Path of the Task definition file that supplied this layer. */
  path: string;
}

/** Stable per-task identity row with persisted layer and merged effective settings. */
export interface TaskSettingsTaskRow {
  /** Stable identity: `builtin:<name>` or `project:<project>:<name>`. */
  identity: string;
  name: string;
  /** Authoritative display label; falls back to the exact task `name`. */
  display_name: string;
  project?: string;
  /** Authoritative project display label on project rows; falls back to the exact project id. */
  project_display_name?: string;
  builtin: TaskSettingsBuiltinMetadata;
  /** Persisted per-task user layer for this identity. */
  user_task: TaskSettingsLayer;
  effective: TaskSettingsEffective;
  /** Daemon resolution projection; present only when the daemon resolves. */
  explicit?: TaskSettingsExplicitRow;
  /** Automatic resolution projection; present only on automatic rows the daemon resolves. */
  automatic_selection?: TaskSettingsAutomaticSelection;
  /** Ordered base→effective definition layers; present only when this row's
   *  definition inherits from another layer. */
  inheritanceChain?: TaskDefinitionInheritanceLayer[];
  issues: TaskSettingsValidationIssue[];
}

export interface TaskSettingsSnapshot {
  config_path: string;
  revision: string;
  project?: string;
  /** Persisted user-global settings layer. */
  user_global: TaskSettingsLayer;
  rows: TaskSettingsTaskRow[];
  /** Read-only runtime alias projection used to suggest explicit references. */
  aliases: RuntimeAliasEntry[];
  /** Optional backend load failures surfaced when some task sources could not be read. */
  load_errors?: Array<{
    source_path: string;
    file_name: string;
    message: string;
    project?: string;
    project_display_name?: string;
  }>;
}

/** A validation problem surfaced by the daemon for a runtime alias entry. */
export interface RuntimeAliasIssue {
  code: string;
  message: string;
  field?: string;
}

/**
 * One stored runtime alias binding a name to a canonical `provider/model:client`
 * target. Names follow `^[a-z0-9][a-z0-9._-]{0,63}$`; the store is daemon-owned.
 */
export interface RuntimeAliasEntry {
  name: string;
  target: string;
  created_at?: string;
  updated_at?: string;
  issues?: RuntimeAliasIssue[];
}

/** Snapshot of the daemon-owned runtime alias store. */
export interface RuntimeAliasSnapshot {
  revision: string;
  aliases: RuntimeAliasEntry[];
}

/** Bounded request for runtime.alias.put; CAS on the store revision. */
export interface RuntimeAliasPutRequest {
  expected_revision: string;
  name: string;
  target: string;
}

/** Bounded request for runtime.alias.remove; CAS on the store revision. */
export interface RuntimeAliasRemoveRequest {
  expected_revision: string;
  name: string;
}

/** Bounded save request for task.settings.save. */
export interface TaskSettingsSaveRequest {
  scope: TaskSettingsScope;
  /** Required when `scope` is 'task'; must be absent for 'global'. */
  task_id?: string;
  /** Optional bounded project hint for task resolution. */
  project?: string;
  expected_revision: string;
  patch: TaskSettingsPatch;
}

/**
 * Form-first routing test contract. Desktop transports the typed form request
 * to the daemon `task.settings.routingTest` method and renders the flattened
 * row projection; it never re-implements routing, scoring, or catalog
 * resolution. The snake_case wire DTO mirrors the daemon DTOs exactly.
 */

/** Typed form request: the raw automatic constraints plus optional timeout. */
export interface TaskRoutingTestParams {
  automatic: TaskSettingsAutomaticDispatch;
  timeout_ms?: number;
}

/**
 * One scoring factor's actual weighted contribution from the shared scorer.
 * The four factor contributions sum exactly to `score`; they are backend
 * provided and never recomputed in the renderer.
 */
export interface TaskRoutingTestRow {
  provider: string;
  provider_name: string;
  model: string;
  model_name: string;
  effective_tps: number | null;
  price_score: number | null;
  speed_score: number | null;
  quota_score: number | null;
  intelligence_score: number | null;
  score: number | null;
  rank: number | null;
  /** Short Chinese reason; populated for rejected rows, null for qualified rows. */
  reason: string | null;
}

/** Flattened routing-test result; `rows` preserves backend ordering. */
export interface TaskRoutingTestResult {
  rows: TaskRoutingTestRow[];
}

/** One importable task definition with its raw automatic configuration. */
export interface TaskRoutingTestTask {
  identity: string;
  name: string;
  display_name: string;
  project?: string;
  automatic: TaskSettingsAutomaticDispatch;
  timeout_ms?: number;
}

/** Read-only projection of every valid builtin and project task definition. */
export interface TaskRoutingTestTasksResult {
  tasks: TaskRoutingTestTask[];
}

/**
 * Raw prompt-execution surface. Desktop is only a typed transport for the
 * daemon's `exec.*` IPC methods: it forwards an already-resolved client/
 * provider/model/mode/thinking/cwd and renders snapshots and events. It never
 * resolves a model, reads a catalog, or persists an execution. Every field
 * mirrors the daemon's snake/camel wire DTOs exactly; ids are opaque strings and
 * timestamps are epoch milliseconds.
 */
import type {
  ExecStatus, ExecSnapshot as ExecSnapshotDto, ExecStartParams as ExecStartRequest,
  ExecEventEnvelope as ExecEventEnvelopeDto, ExecEventsParams as ExecEventsRequest,
  ExecEventsResult, ExecCancelResult,
} from '@wrenyard/protocol/exec';
export type {
  ExecStatus, ExecSnapshotDto, ExecStartRequest, ExecEventEnvelopeDto,
  ExecEventsRequest, ExecEventsResult, ExecCancelResult,
};
export interface WrenyardShellApi {
  platform: NodeJS.Platform;
  /**
   * Appearance resolved by the main process and passed through
   * `--wy-appearance` at preload time, so the boot script can set the theme
   * before React mounts and no light flash occurs.
   */
  readonly initialAppearance: ResolvedAppearance;
  getAppearance(): Promise<ResolvedAppearance>;
  onAppearanceChanged(listener: (appearance: ResolvedAppearance) => void): () => void;
  navigate(page: ShellPage): Promise<void>;
  /** Pop the native application menu at a renderer anchor (Windows only). */
  showAppMenu(position?: AppMenuPosition): Promise<void>;
  onWindowStateChanged(listener: (state: WindowStateSnapshot) => void): () => void;
  getSettings(): Promise<SettingsSnapshot>;
  getStats(): Promise<StatsSnapshot>;
  getQuota(forceRefresh?: boolean): Promise<QuotaSnapshot>;
  saveProviderOrder(providerIds: string[]): Promise<QuotaSnapshot>;
  configureProviderKey(providerId: string, key: string): Promise<QuotaSnapshot>;
  openProviderKeyPage(providerId: string): Promise<void>;
  getUpdate(): Promise<UpdateSnapshot>;
  checkUpdate(): Promise<UpdateSnapshot>;
  requestInstall(): Promise<UpdateSnapshot>;
  getDaemon(): Promise<DaemonLifecycleSnapshot>;
  startDaemon(): Promise<DaemonLifecycleSnapshot>;
  restartDaemon(): Promise<DaemonLifecycleSnapshot>;
  onDaemonChanged(listener: () => void): () => void;
  /** Latest shared activity projection for the status bar (chrome spec 4.4). */
  getActivityStatus(): Promise<ActivityStatusSnapshot>;
  /** Pushed only when the projected activity content changes. */
  onActivityChanged(listener: (snapshot: ActivityStatusSnapshot) => void): () => void;
  savePetSettings(settings: PetCompanionSettings): Promise<SettingsSnapshot>;
  saveWorkspace(path: string, create?: boolean): Promise<WorkspaceConfigurationSnapshot>;
  openTaskTranscript(taskRunId: string): Promise<void>;
  /** Open the native Graph Slip window for a live task graph (never a transcript). */
  openTaskGraph(taskGraphId: string): Promise<void>;
  copyText(text: string): Promise<void>;
  /** Open an `http:`/`https:` URL in the OS browser; other schemes are rejected. */
  openExternal(url: string): Promise<void>;
  onQuotaChanged(listener: () => void): () => void;
  onUpdateChanged(listener: () => void): () => void;
  onViewChanged(listener: (page: ShellPage) => void): () => void;
  getTaskSettings(project?: string, taskId?: string): Promise<TaskSettingsSnapshot>;
  saveTaskSettings(request: TaskSettingsSaveRequest): Promise<TaskSettingsSnapshot>;
  runtimeAliasSnapshot(): Promise<RuntimeAliasSnapshot>;
  runtimeAliasPut(request: RuntimeAliasPutRequest): Promise<RuntimeAliasSnapshot>;
  runtimeAliasRemove(request: RuntimeAliasRemoveRequest): Promise<RuntimeAliasSnapshot>;
  requestTaskRoutingTest(params: TaskRoutingTestParams): Promise<TaskRoutingTestResult>;
  requestRoutingTestTasks(): Promise<TaskRoutingTestTasksResult>;
  getSummarySettings(): Promise<SummarySettingsSnapshot>;
  saveSummaryModel(canonicalModel: string): Promise<SummarySettingsSnapshot>;
  execStart(request: ExecStartRequest): Promise<ExecSnapshotDto>;
  execGet(id: string): Promise<ExecSnapshotDto>;
  execEvents(request: ExecEventsRequest): Promise<ExecEventsResult>;
  execCancel(id: string): Promise<ExecCancelResult>;
  /** Current session-only notification history, unread count and DND flag. */
  getNotifications(): Promise<NotificationSnapshot>;
  /** Record an event notification (toast + history); returns the stored item. */
  notify(input: NotificationInput): Promise<ShellNotification>;
  dismissNotification(id: string): Promise<void>;
  clearNotifications(): Promise<void>;
  /** Open the notification center: marks every notification read. */
  markNotificationsRead(): Promise<void>;
  setDoNotDisturb(value: boolean): Promise<NotificationSnapshot>;
  onNotificationsChanged(listener: () => void): () => void;
  /** Main-process command delivery (e.g. a native-notification click). */
  onCommandAction(listener: (action: NotificationCommandAction) => void): () => void;
  /** Current version 3 Desktop preference partitions, main-process owned. */
  getPreferences(): Promise<DesktopPreferences>;
  /** Validate and persist one preference by id; returns the fresh snapshot. */
  setPreference(id: PreferenceId, value: unknown): Promise<DesktopPreferences>;
  onPreferencesChanged(listener: (preferences: DesktopPreferences) => void): () => void;
  /** Open the Desktop settings file with the OS default editor. */
  openSettingsFile(): Promise<void>;
  /** Open the Wrenyard state logs directory. */
  openLogsDirectory(): Promise<void>;
  /** Reveal a workspace path in the OS file manager. */
  revealWorkspace(path: string): Promise<void>;
}

export function isShellPage(value: unknown): value is ShellPage {
  return value === 'session' || value === 'stats' || value === 'quota' || value === 'settings' || value === 'tasks';
}

/**
 * Hardcoded official key-creation pages for providers that need an external
 * visit to mint an API key. The renderer passes only the provider id; the
 * resolved URL is always one of these fixed values and never renderer input.
 */
export const PROVIDER_KEY_PAGE_URLS: Readonly<Record<string, string>> = {
  'opencode-zen': 'https://opencode.ai/auth',
  openrouter: 'https://openrouter.ai/settings/keys',
};

/**
 * Resolves the fixed official key-creation URL for an allowlisted provider id.
 * Returns null for every other value so no arbitrary URL can reach
 * `shell.openExternal` through this contract.
 */
export function providerKeyPageUrl(providerId: unknown): string | null {
  if (typeof providerId !== 'string' || !Object.hasOwn(PROVIDER_KEY_PAGE_URLS, providerId)) return null;
  const url = PROVIDER_KEY_PAGE_URLS[providerId];
  return url === undefined ? null : url;
}

export function isSettingsLaunchRequest(value: string): boolean {
  if (value === '--settings') return true;
  try {
    const target = new URL(value);
    return target.protocol === 'wrenyard:'
      && target.hostname === 'settings'
      && (target.pathname === '' || target.pathname === '/');
  } catch {
    return false;
  }
}

export interface AcceleratorInput {
  key: string;
  meta?: boolean;
  control?: boolean;
}

export function acceleratorPage(input: AcceleratorInput, platform: NodeJS.Platform): ShellPage | null {
  const command = platform === 'darwin' ? input.meta === true : input.control === true;
  if (!command) return null;
  if (input.key === ',') return 'settings';
  if (input.key === '1') return 'session';
  if (input.key === '2') return 'stats';
  if (input.key === '3') return 'quota';
  if (input.key === '4') return 'tasks';
  return null;
}

/* ------------------------------------------------------------------ */
/* Keyboard shortcuts                                                  */
/* ------------------------------------------------------------------ */

/** Where a shortcut applies, as a product-facing Chinese label. */
export type ShortcutScope = '全局' | '会话页' | '输入框';

/**
 * One read-only shortcut row. `mac`/`other` use the platform glyphs; a missing
 * value means the shortcut does not exist on that platform. `page` is present
 * when the shortcut is also handled by {@link acceleratorPage}; `command` is
 * the command-table id the shell runs, when it is not a plain navigation key.
 */
export interface KnownShortcut {
  category: string;
  title: string;
  mac?: string;
  other?: string;
  scope: ShortcutScope;
  page?: ShellPage;
  command?: string;
}

/**
 * The complete static shortcut table shown by the settings shortcuts category.
 * It mirrors the implemented accelerators: every {@link acceleratorPage}
 * combination appears here, and every accelerator spelled out in
 * `desktopMenuTemplate` is present. Menu roles (`editMenu`, `resetZoom`, …)
 * list Electron's default bindings by hand. Customization will later be
 * derived from the command table; the layout stays the same.
 */
export const KNOWN_SHORTCUTS: readonly KnownShortcut[] = [
  { category: '导航', title: '会话', mac: '⌘1', other: 'Ctrl+1', scope: '全局', page: 'session' },
  { category: '导航', title: '台账', mac: '⌘2', other: 'Ctrl+2', scope: '全局', page: 'stats' },
  { category: '导航', title: '模型供应', mac: '⌘3', other: 'Ctrl+3', scope: '全局', page: 'quota' },
  { category: '导航', title: '任务', mac: '⌘4', other: 'Ctrl+4', scope: '全局', page: 'tasks' },
  { category: '导航', title: '设置', mac: '⌘,', other: 'Ctrl+,', scope: '全局', page: 'settings' },
  { category: '导航', title: '后退', mac: '⌘[', other: 'Alt+←', scope: '全局', command: 'nav.back' },
  { category: '导航', title: '前进', mac: '⌘]', other: 'Alt+→', scope: '全局', command: 'nav.forward' },
  { category: '视图', title: '切换侧栏', mac: '⌘B', other: 'Ctrl+B', scope: '全局', command: 'view.toggleSidebar' },
  { category: '视图', title: '实际大小', mac: '⌘0', other: 'Ctrl+0', scope: '全局' },
  { category: '视图', title: '放大', mac: '⌘+', other: 'Ctrl++', scope: '全局' },
  { category: '视图', title: '缩小', mac: '⌘-', other: 'Ctrl+-', scope: '全局' },
  { category: '视图', title: '全屏', mac: '⌃⌘F', other: 'F11', scope: '全局' },
  { category: '会话', title: '搜索会话', mac: '⌘K', other: 'Ctrl+K', scope: '会话页' },
  { category: '会话', title: '发送消息', mac: 'Enter', other: 'Enter', scope: '输入框' },
  { category: '会话', title: '换行', mac: '⇧Enter', other: 'Shift+Enter', scope: '输入框' },
  { category: '会话', title: '关闭检查器', mac: 'Esc', other: 'Esc', scope: '会话页' },
  { category: '编辑', title: '撤销', mac: '⌘Z', other: 'Ctrl+Z', scope: '全局' },
  { category: '编辑', title: '重做', mac: '⇧⌘Z', other: 'Ctrl+Y', scope: '全局' },
  { category: '编辑', title: '剪切', mac: '⌘X', other: 'Ctrl+X', scope: '全局' },
  { category: '编辑', title: '复制', mac: '⌘C', other: 'Ctrl+C', scope: '全局' },
  { category: '编辑', title: '粘贴', mac: '⌘V', other: 'Ctrl+V', scope: '全局' },
  { category: '编辑', title: '全选', mac: '⌘A', other: 'Ctrl+A', scope: '全局' },
  { category: '窗口', title: '最小化', mac: '⌘M', scope: '全局' },
  { category: '窗口', title: '关闭窗口', mac: '⌘W', scope: '全局' },
  { category: '应用', title: '隐藏啾啾工坊', mac: '⌘H', scope: '全局' },
  { category: '应用', title: '隐藏其他', mac: '⌥⌘H', scope: '全局' },
  { category: '应用', title: '检查更新', mac: '⇧⌘U', other: 'Ctrl+Shift+U', scope: '全局' },
  { category: '应用', title: '退出', mac: '⌘Q（连按两次）', other: 'Ctrl+Q', scope: '全局' },
];

/** Platform key text for one shortcut, or null when it does not apply. */
export function knownShortcutKeys(shortcut: KnownShortcut, platform: NodeJS.Platform): string | null {
  return platform === 'darwin' ? shortcut.mac ?? null : shortcut.other ?? null;
}
