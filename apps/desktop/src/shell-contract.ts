import type {
  AppConfig,
  EntityVisibilityConfig,
  PetSettingsPayload,
  QuotaProviderEntry,
  WindowGeometry,
} from './pet/main/config';
import { BUILTIN_THEMES, type ThemeId } from '@wrenyard/themes';
import type {
  AppNotification,
  NotificationAction,
  NotificationCommandAction,
  NotificationLevel,
} from './main/notifications/notifier';
import type {
  ContextInspection,
  ContextItem,
  ContextItemKind,
  ContextLayerId,
  LedgerEvent,
} from '@wrenyard/protocol/session';
import type { QuotaState } from '@wrenyard/auto-routing';
import type {
  GatewayHealthPool,
  GatewayHealthProvider,
  GatewayHealthRoute,
  GatewayHealthWindow,
  GatewayHealthResult as WrenyardGatewayHealthResult,
  GatewayPortChoice as WrenyardGatewayPortChoice,
  GatewaySettings as WrenyardGatewaySettings,
  GatewaySettingsSaveInput as WrenyardGatewaySettingsSaveInput,
  GatewaySettingsSaveResult as WrenyardGatewaySettingsSaveResult,
} from '@wrenyard/protocol/gateway';
import type {
  TaskSettingsAutomaticDispatch as ProtocolTaskSettingsAutomaticDispatch,
  TaskSettingsLayer as ProtocolTaskSettingsLayer,
  TaskSettingsIntelligence,
  TaskSettingsCapability,
  TaskSettingsSourcedValue,
  TaskSettingsAutomaticSelection,
  TaskSettingsResolvedDispatch,
  TaskSettingsEffective,
  TaskSettingsBuiltinMetadata,
  TaskResolutionFailure as TaskSettingsResolutionFailure,
  TaskInheritanceChainEntry as TaskDefinitionInheritanceLayer,
  TaskSettingsSnapshotResult as TaskSettingsSnapshot,
  TaskSettingsSaveParams as TaskSettingsSaveRequest,
  TaskRoutingTestParams,
  TaskRoutingTestRow,
  TaskRoutingTestResult,
  TaskRoutingTestTask,
  TaskRoutingTestTasksResult,
  TaskDefinitionListResult,
  TaskUsageLive,
  TaskUsageLiveListParams,
  TaskUsageLiveListResult,
} from '@wrenyard/protocol/task';
import type { DailyBucket as StatsDailySnapshot } from '@wrenyard/protocol/stats';
import type {
  ProviderListModel,
  ProviderListModelPricing as ProviderModelPricingSnapshot,
  ProviderSignInResult,
} from '@wrenyard/protocol/provider';
import type { StorageUsageResult as StorageUsageSnapshot } from '@wrenyard/protocol/storage';
import type {
  AgentBotLocation,
  AgentBotSummary,
  AgentCreateParams,
  AgentCreateResult,
  AgentEventsParams,
  AgentGetParams,
  AgentGetResult,
  AgentGroupEventsParams,
  AgentGroupEventsResult,
  AgentGroupSendParams,
  AgentGroupSendResult,
  AgentListResult,
  AgentMemoryFile,
  AgentMemoryListParams,
  AgentMemoryListResult,
  AgentMethods,
  AgentWakeParams,
  AgentWakeResult,
  GroupMessage,
} from '@wrenyard/protocol/agent';
import type {
  RoutineCreateParams,
  RoutineCreateResult,
  RoutineDeleteParams,
  RoutineDeleteResult,
  RoutineListParams,
  RoutineListResult,
  RoutineMethods,
  RoutineRecord,
  RoutineRunParams,
  RoutineRunResult,
  RoutineUpdateParams,
  RoutineUpdateResult,
} from '@wrenyard/protocol/routine';
import type {
  Todo,
  TodoComment,
  TodoCreateInput,
  TodoCreateParams,
  TodoCreateResult,
  TodoListParams,
  TodoListResult,
  TodoStatus,
  TodoUpdateInput,
  TodoUpdateResult,
  TodoAddTagsInput,
  TodoRemoveTagInput,
  TodoAppendCommentInput,
  TodoDeleteCommentInput,
  TodoTagResult,
  TodoCommentResult,
} from '@wrenyard/protocol/workspace';
import type {
  ClientAction,
  ClientActionParams,
  ClientActionResult,
  ClientListEntry,
  ClientListHost,
  ClientListResult,
  ClientMethods,
  ClientReadiness,
} from '@wrenyard/protocol/client';
import type {
  OperationComponentAction,
  OperationComponentHint,
  OperationComponentId,
  OperationComponentSnapshot,
  OperationComponentState,
} from '@wrenyard/protocol/components';

// The gateway access DTOs are owned by the protocol package; the shell contract
// re-exports them under the local names so the preload facade and the renderer
// resolve them from `@/shell-contract` without importing the protocol directly.
export type {
  GatewayHealthPool,
  GatewayHealthProvider,
  GatewayHealthRoute,
  GatewayHealthWindow,
  WrenyardGatewayHealthResult,
  WrenyardGatewaySettings,
  WrenyardGatewaySettingsSaveInput,
  WrenyardGatewaySettingsSaveResult,
  WrenyardGatewayPortChoice,
};

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
export type { ContextInspection, ContextItem, ContextItemKind, ContextLayerId, };

// The notifier and in-app center DTOs own the notification wire shape; the
// shell contract re-exports them so the preload facade, main handlers and
// renderer all read one definition.
export type {
  AppNotification,
  NotificationAction,
  NotificationCommandAction,
  NotificationLevel,
};

/** Upper bound for a renderer-supplied notification id crossing the shell bridge. */
export const NOTIFICATION_ID_MAX = 200;

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
 * Closed outcome of the daemon's `workspace.switch` method, mirrored into the
 * shell contract so the renderer can tell a busy daemon from an invalid target
 * or a pinned root. The `saveWorkspace` bridge applies a workspace change
 * through that daemon method — the daemon stays running and owns the
 * authoritative `workspace.root` — and rejects with the daemon's own message
 * when the outcome is not `switched`; the resolved value is the refreshed
 * workspace snapshot read back from the daemon-owned config.
 */
export type WorkspaceSwitchOutcome =
  | 'switched'
  | 'busy'
  | 'invalid'
  | 'shutting_down'
  | 'pinned'
  | 'unavailable'
  | 'error';

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
  /** Gateway execution identity backing this run when an execution exists. */
  executionId?: string;
  /** Resolved dispatch mode of the run ('gateway' | 'native') when recorded. */
  executionMode?: 'native' | 'gateway';
  /** Whether this run is a dispatched task or an in-session auxiliary run. */
  kind?: 'task' | 'auxiliary';
  taskName?: string;
  /** Auxiliary-only: the auxiliary role that ran (document, todo, vcs, ...). */
  role?: string;
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

/**
 * Exact-ID task brief for the session metrics panel, projected from the
 * `task.run.status` result for one dispatched `taskRunId`. Every optional field
 * stays optional so historical runs and unresolved ids remain valid; `usage`
 * carries the full per-run projection when the daemon returned one.
 */
export interface DesktopTaskBrief {
  taskRunId: string;
  executionId?: string;
  executionMode?: 'native' | 'gateway';
  /** `task_name`, falling back to `task_id` when the definition declares none. */
  taskName?: string;
  /** Task-run status, or `unavailable` when this id could not be resolved. */
  status: string;
  /** Resolved client/provider/model label, when a runtime was resolved. */
  runtime?: string;
  summary?: string;
  usage?: TaskRunUsage;
}

export const ACTIVITY_BAR_WIDTH = 48;

export const SHELL_CHANNELS = {
  navigate: 'wrenyard-shell:navigate',
  showAppMenu: 'wrenyard-shell:show-app-menu',
  openMiniCard: 'wrenyard-shell:open-mini-card',
  restoreMain: 'wrenyard-shell:restore-main',
  alwaysOnTop: 'wrenyard-shell:always-on-top',
  closeWindow: 'wrenyard-shell:close-window',
  windowStateChanged: 'wrenyard-shell:window-state-changed',
  appearanceSnapshot: 'wrenyard-shell:appearance-snapshot',
  appearanceChanged: 'wrenyard-shell:appearance-changed',
  settingsSnapshot: 'wrenyard-shell:settings-snapshot',
  gatewaySettings: 'wrenyard-shell:gateway-settings',
  gatewaySettingsSave: 'wrenyard-shell:gateway-settings-save',
  gatewayHealth: 'wrenyard-shell:gateway-health',
  statsSnapshot: 'wrenyard-shell:stats-snapshot',
  quotaSnapshot: 'wrenyard-shell:quota-snapshot',
  saveProviderOrder: 'wrenyard-shell:save-provider-order',
  quotaFocus: 'wrenyard-shell:quota-focus',
  storageUsage: 'wrenyard-shell:storage-usage',
  savePetSettings: 'wrenyard-shell:save-pet-settings',
  saveWorkspace: 'wrenyard-shell:save-workspace',
  taskTranscript: 'wrenyard-shell:task-transcript',
  taskGraph: 'wrenyard-shell:task-graph',
  copyText: 'wrenyard-shell:copy-text',
  openExternal: 'wrenyard-shell:open-external',
  configureProviderKey: 'wrenyard-shell:configure-provider-key',
  signInProvider: 'wrenyard-shell:sign-in-provider',
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
  notificationShow: 'wrenyard-shell:notification-show',
  commandAction: 'wrenyard-shell:command-action',
  taskSettingsSnapshot: 'wrenyard-shell:task-settings-snapshot',
  taskSettingsSave: 'wrenyard-shell:task-settings-save',
  taskRoutingTest: 'wrenyard-shell:task-routing-test',
  taskRoutingTestTasks: 'wrenyard-shell:task-routing-test-tasks',
  taskDefinitionList: 'wrenyard-shell:task-definition-list',
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
  remoteState: 'wrenyard-shell:remote-state',
  remoteHostList: 'wrenyard-shell:remote-host-list',
  remoteHostDiscovered: 'wrenyard-shell:remote-host-discovered',
  remoteHostTest: 'wrenyard-shell:remote-host-test',
  remoteHostConfirm: 'wrenyard-shell:remote-host-confirm',
  remoteHostRename: 'wrenyard-shell:remote-host-rename',
  remoteHostConnect: 'wrenyard-shell:remote-host-connect',
  remoteReturnLocal: 'wrenyard-shell:remote-return-local',
  remoteChanged: 'wrenyard-shell:remote-changed',
  operationComponents: 'wrenyard-shell:operation-components',
  operationComponentAction: 'wrenyard-shell:operation-component-action',
  todoRequest: 'wrenyard-shell:todo-request',
  botTodoRequest: 'wrenyard-shell:bot-todo-request',
  agentRequest: 'wrenyard-shell:agent-request',
  clientRequest: 'wrenyard-shell:client-request',
  taskRequest: 'wrenyard-shell:task-request',
  taskUsageLive: 'wrenyard-shell:task-usage-live',
} as const;

export type ShellPage = 'session' | 'trace' | 'stats' | 'settings' | 'tasks' | 'agents' | 'routines' | 'todo';

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

/** The currency every price and cost is displayed in. */
export type DisplayCurrency = 'CNY' | 'USD';

export const DISPLAY_CURRENCY_OPTIONS: ReadonlyArray<{ value: DisplayCurrency; label: string }> = [
  { value: 'CNY', label: '人民币' },
  { value: 'USD', label: '美元' },
];

/** Fixed conversion rate used for display: 1 USD = 7 CNY. */
export const CNY_PER_USD = 7;

export function formatQuotaBalance(
  balance: { currency?: string; amount: string | null; display: string; unit?: string },
  displayCurrency: DisplayCurrency,
): string {
  // Unit-denominated and currency-less rows are never converted.
  if (balance.currency === undefined) return balance.display;
  if (balance.currency === 'USD' && displayCurrency === 'CNY') {
    return `¥${(Number(balance.amount) * CNY_PER_USD).toFixed(2)}`;
  }
  if (balance.currency === 'CNY' && displayCurrency === 'USD') {
    return `$${(Number(balance.amount) / CNY_PER_USD).toFixed(2)}`;
  }
  return balance.display;
}

export const SESSION_SEND_KEY_OPTIONS: ReadonlyArray<{ value: SessionSendKey; label: string }> = [
  { value: 'enter', label: 'Enter 发送' },
  { value: 'mod-enter', label: 'Cmd/Ctrl+Enter 发送' },
];

/**
 * Desktop notification preferences: one boolean master switch. A disabled
 * notifier delivers nothing on any channel.
 */
export interface NotificationPreferences {
  enabled: boolean;
}

/** Persisted general partition fields. */
export interface GeneralPreferences {
  startupPage: StartupPagePreference;
  displayCurrency: DisplayCurrency;
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

/** How the sidebar conversation list groups sessions. */
export type SessionGroupBy = 'date' | 'status' | 'none';

/** How the sidebar conversation list orders sessions. */
export type SessionSortBy = 'updated' | 'created' | 'title';

/** Which sessions the sidebar conversation list shows. */
export type SessionStatusFilter = 'active' | 'archived' | 'all';

/** Sidebar grouping default: the date buckets the list has always used. */
export const SESSION_GROUP_BY_DEFAULT: SessionGroupBy = 'date';
/** Sidebar sort default: newest last-updated first, as before. */
export const SESSION_SORT_BY_DEFAULT: SessionSortBy = 'updated';
/** Sidebar status-filter default: active sessions only, as before. */
export const SESSION_STATUS_FILTER_DEFAULT: SessionStatusFilter = 'active';

/**
 * Renderer-visible session preferences. The retired model-default and
 * last-sent memory keys are no longer part of the product surface: a new
 * session inherits the model and effort from the client-local first-request
 * record, so only the message-submit key remains here. The sidebar list
 * controls (grouping, sorting, status filter) join it; an absent field
 * resolves to its default above.
 */
export interface SessionPreferences {
  sendKey: SessionSendKey;
  /**
   * Whether the composer may show a next-input suggestion. Suggestions use only
   * the current conversation's own user and assistant text; nothing else leaves
   * the session.
   */
  promptCompletion: boolean;
  groupBy?: SessionGroupBy;
  sortBy?: SessionSortBy;
  statusFilter?: SessionStatusFilter;
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
  update: UpdatePreferences;
}

/** The Desktop preference partitions a preference path can address. */
export type PreferenceSection = 'general' | 'appearance' | 'session' | 'notifications' | 'update';

/** Path from a preference id to the value it addresses inside a preference document. */
export type PreferencePath = readonly [PreferenceSection, string];

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
  'general.displayCurrency': { path: ['general', 'displayCurrency'], validate: (value) => value === 'CNY' || value === 'USD' },
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
  'session.promptCompletion': { path: ['session', 'promptCompletion'], validate: (value) => typeof value === 'boolean' },
  'session.groupBy': {
    path: ['session', 'groupBy'],
    validate: (value) => value === 'date' || value === 'status' || value === 'none',
  },
  'session.sortBy': {
    path: ['session', 'sortBy'],
    validate: (value) => value === 'updated' || value === 'created' || value === 'title',
  },
  'session.statusFilter': {
    path: ['session', 'statusFilter'],
    validate: (value) => value === 'active' || value === 'archived' || value === 'all',
  },
  'notifications.enabled': { path: ['notifications', 'enabled'], validate: (value) => typeof value === 'boolean' },
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
 * Immutable write of one preference: only the touched partition is copied.
 */
export function writePreferenceValue<T extends PreferenceDocument>(
  preferences: T,
  id: PreferenceId,
  value: unknown,
): T {
  const path = PREFERENCES[id].path as readonly string[];
  const document = preferences as unknown as Record<string, Record<string, unknown>>;
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
  status: 'connected' | 'unresponsive' | 'unavailable';
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

/**
 * Structured progress for an in-flight update, shared by the updater and every
 * renderer surface. One definition crosses the bridge: the main process reports
 * it on the installing snapshot and the UI reads it back. A phase without a
 * known total size is indeterminate and never faked as a percentage.
 */
export interface UpdateProgress {
  phase: 'downloading' | 'verifying' | 'extracting' | 'applying';
  /** Bytes received so far; present only during `downloading`. */
  receivedBytes?: number;
  /** Total expected bytes; present only when Content-Length is known. */
  totalBytes?: number;
  /** Completion percentage 0–100; present only when the total size is known. */
  percent?: number;
}

export interface UpdateSnapshot {
  state: UpdateState;
  currentVersion: string;
  availableVersion?: string;
  checkedAt?: number;
  installSupported: boolean;
  /** Present only while `installSupported` is false. */
  installReason?: UpdateInstallReason;
  message?: string;
  /** Structured install progress; absent unless an install attempt is running. */
  progress?: UpdateProgress;
  /**
   * Note rendered beside the install action, e.g. when the fresh pre-install
   * check failed and the last known release is installed instead. Carried
   * through the install phases and cleared by the next check.
   */
  installWarning?: string;
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
  /** Socket connected, but the health reply missed its deadline. */
  | 'unresponsive'
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
  /** 1-based desktop-lane queue position; present only while the run waits. */
  queuePosition?: number;
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

export interface DaemonLifecycleNotification {
  reason: 'state-changed' | 'task-usage-reconnect';
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
  /**
   * First-dispatch-today task cohort (unique tasks whose earliest canonical
   * execution landed in the daemon-local day; queued dispatches included,
   * retries counted once). Optional so a desktop build tolerates a daemon that
   * does not return it; never substituted from `dispatchCount`/`outcomes.done`.
   */
  taskDispatches?: { count: number; done: number };
}

export type { StatsDailySnapshot };

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

/**
 * Four-level per-pool quota state, the same levels automatic routing uses:
 * `abundant` 充裕, `sufficient` 足够, `insufficient` 不足, `exhausted` 用尽.
 * Aliased to the canonical routing state so the levels are declared once.
 */
export type QuotaPoolState = QuotaState;

export interface QuotaWindowSnapshot {
  name: string;
  /** Display-only pool label (declared display name or pool id); `name` stays the key. */
  poolLabel?: string;
  remainingPct: number;
  expectedRemainingPct: number | null;
  /** ISO 8601 reset time; omitted when invalid or already past. */
  resetsAt?: string;
  /** Window length in minutes; drives the Chinese window label. */
  windowMinutes?: number;
  /** Per-pool state from the shared quota rules; absent when none can be derived. */
  state?: QuotaPoolState;
}

export interface QuotaBalanceSnapshot {
  /** Stable balance identity when the provider distinguishes one (e.g.
   * `chatgpt/credits`); absent for a plain monetary row. */
  id?: string;
  /** Uppercase ISO-4217 code of a monetary row; absent on a unit row. */
  currency?: string;
  /** Verbatim decimal-string amount; null means reported-but-unknown. */
  amount: string | null;
  /** Non-currency display unit of a unit-denominated row (e.g. `Credits`). */
  unit?: string;
  /** Provider-declared unlimited balance. */
  unlimited?: boolean;
  /** Parser-attested flag availability (ChatGPT Credits only). */
  availability?: 'available' | 'unavailable' | 'unknown';
  display: string;
  /** Per-pool state from the shared quota rules; a balance is never abundant. */
  state?: QuotaPoolState;
}

/** Estimated spend inside one named quota window (daemon-computed, display-only). */
export interface QuotaSpendEstimate {
  /** Quota window `name` this estimate covers. */
  window: string;
  /** USD per public model id (e.g. `devin/swe-2`), estimated from recorded token usage. */
  models: Record<string, number>;
  /** Total estimated USD across all models in the window. */
  totalUsd: number;
}

export interface QuotaProviderSnapshot {
  id: string;
  label: string;
  /** Explicit provider-reported account plan name; absent means unknown. */
  plan?: string;
  status: 'ok' | 'pending' | 'error' | 'unavailable';
  stale: boolean;
  /**
   * Epoch ms of this provider's last successful quota read. It drives the
   * grace-aware read-failure note (`读取失败，沿用 N 分钟前的数据`); absent
   * means no usable measurement was ever taken.
   */
  lastSuccessAt?: number;
  windows: QuotaWindowSnapshot[];
  balances: QuotaBalanceSnapshot[];
  /**
   * Daemon-computed per-window estimated USD spend, keyed to a window `name`
   * (Devin only). Absent for other providers and when no traffic was recorded.
   */
  estimatedSpend?: QuotaSpendEstimate[];
  /** ChatGPT subscription-first funding source (Desktop main-computed); absent for other providers. */
  fundingSource?: 'subscription' | 'credits' | 'exhausted' | 'unresolved';
  displayLine?: string;
  message?: string;
  code?: string;
  /**
   * Verified login type the provider reported for this observation (for example
   * an enterprise single-sign-on login); absent when it reports none. Carried verbatim
   * from the protocol snapshot, never derived from quota numbers.
   */
  accountType?: string;
  /** Verified identity provider of that login (e.g. `ioa_auth`); absent when
   * the provider reports none. */
  idp?: string;
}

/**
 * Display-only quota focus: the quota provider of the model currently selected
 * in the composer, published by the renderer so Desktop main can forward it to
 * the Pet house card. `id` is the provider identity; `label` is an optional
 * display name when the renderer can supply one. It is never a routing or
 * storage key.
 */
export interface QuotaFocus {
  id: string;
  label?: string;
}

export type ProviderAuthMode = 'api-key' | 'environment' | 'native' | 'none';

/** USD per million tokens: [cached, input, output]. */
export type { ProviderModelPricingSnapshot };

/** Shared provider-model row for the Provider and Model List surfaces.
 *  Extends the protocol `ProviderListModel`; the protocol additionally carries
 *  optional catalog fields (`reasoningEfforts`, `supportedClients`,
 *  `contextWindow`, `maxTokens`, `taskOnly`) the Desktop surface ignores. */
export interface ProviderModelSnapshot extends ProviderListModel {}

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
 * Read-only WY data-directory usage snapshot (`storage.usage`), mirrored from
 * the daemon contract. `result` is the last successful scan; `status` describes
 * the current or most recent scan, so a running or failed re-scan may still
 * carry the previous `result`.
 */
export type { StorageUsageSnapshot };

/**
 * How many points a window's remaining percentage may trail its expected
 * remaining percentage before the pace is considered too fast.
 */
export const QUOTA_PACE_WARN_DELTA = 5;

/**
 * The eligible quota providers shared by the quota producer and the status
 * bar: when an explicit order exists, only the order-enabled providers;
 * otherwise every provider.
 */
export function eligibleQuotaProviders(snapshot: QuotaSnapshot): QuotaProviderSnapshot[] {
  if (snapshot.providerOrder.length === 0) return snapshot.providers;
  const enabled = new Set(snapshot.providerOrder.filter((entry) => entry.enabled).map((entry) => entry.id));
  return snapshot.providers.filter((provider) => enabled.has(provider.id));
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

/** Automatic dispatch field enums (mirrors the task dispatch requirements). */
export type { TaskSettingsIntelligence, TaskSettingsCapability };

/**
 * JSON-safe snake_case automatic dispatch constraints a user layer may set.
 * The protocol declaration additionally carries `fast` and
 * `expected_reasoning_effort`; Desktop narrows them out because its form does
 * not edit them.
 */
export type TaskSettingsAutomaticDispatch = Omit<
  ProtocolTaskSettingsAutomaticDispatch,
  'fast' | 'expected_reasoning_effort'
>;

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
export type { TaskSettingsSourcedValue };

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

export interface TaskSettingsLayer
  extends Omit<
    ProtocolTaskSettingsLayer,
    'automatic' | 'routing_weights' | 'health_error_rate_threshold' | 'retry_sessions' | 'retry_bots'
  > {
  /** Global-only automatic scoring weights; null clears them. */
  routing_weights?: TaskSettingsRoutingWeights | null;
  /** Global-only health-avoidance threshold (percent, 1–100); null clears to default. */
  health_error_rate_threshold?: number | null;
  /** Global-only: retry a main reasoning call; null clears to the default (on). */
  retry_sessions?: boolean | null;
  /** Global-only: retry a bot turn; null clears to the default (on). */
  retry_bots?: boolean | null;
  /** Desktop's dispatch form edits the narrowed automatic dispatch shape. */
  automatic?: Partial<TaskSettingsAutomaticDispatch> | null;
}

/** Field-level save patch; `null` deletes that field only at the selected layer. */
export interface TaskSettingsPatch {
  run_time_limit_minutes?: number | null;
  routing_weights?: TaskSettingsRoutingWeights | null;
  health_error_rate_threshold?: number | null;
  retry_sessions?: boolean | null;
  retry_bots?: boolean | null;
  automatic?: TaskSettingsAutomaticPatch | null;
}

/**
 * Effective automatic dispatch: every field carries its own source layer.
 * The protocol shape additionally carries `expected_reasoning_effort`; the
 * Desktop form omits it, so the field is declared non-present here.
 */
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
export type { TaskSettingsEffective };

/** Structured automatic-resolution failure detail the daemon attaches to an issue. */
export type { TaskSettingsResolutionFailure };

/** A validation problem surfaced by the daemon. */
export interface TaskSettingsValidationIssue {
  code: string;
  message: string;
  field?: string;
  /** Closed structured resolution failure; present only on resolution-failure issues. */
  resolutionFailure?: TaskSettingsResolutionFailure;
}

/**
 * A daemon-owned resolved dispatch projection for an explicit reference.
 * Aliased to the protocol resolved dispatch: it carries the full canonical
 * dispatch fields plus the paired additive Catalog display labels.
 */
export type TaskResolvedDispatch = TaskSettingsResolvedDispatch;

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
/** Read-only metadata about a daemon-builtin task. */
export type { TaskSettingsBuiltinMetadata };

/**
 * Automatic-selection resolution data carried on a row by the daemon when
 * resolved. Mirrors the daemon automatic-selection row projection exactly: when
 * this object is present it is fully populated. Backward compatibility for older
 * snapshots and unresolved rows lives on the optional row-level field
 * `TaskSettingsTaskRow.automatic_selection`, which is omitted until the daemon
 * resolves.
 */
export type { TaskSettingsAutomaticSelection };

/**
 * One layer of a Task definition's inheritance chain, ordered base→effective.
 * The final entry is the effective layer; earlier entries are the layers it
 * inherited from. Desktop renders this read-only and never edits it.
 */
export type { TaskDefinitionInheritanceLayer };

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
  /** Present only on scoped task detail snapshots; omitted from list rows. */
  builtin?: TaskSettingsBuiltinMetadata;
  /** Persisted per-task user layer for this identity. */
  user_task: TaskSettingsLayer;
  effective: TaskSettingsEffective;
  /** Automatic resolution projection; present only when the daemon resolves it. */
  automatic_selection?: TaskSettingsAutomaticSelection;
  /** Ordered base→effective definition layers; present only when this row's
   *  definition inherits from another layer. */
  inheritanceChain?: TaskDefinitionInheritanceLayer[];
  issues: TaskSettingsValidationIssue[];
}

export type { TaskSettingsSnapshot, TaskDefinitionListResult };

/** Bounded save request for task.settings.save. */
export type { TaskSettingsSaveRequest };

/**
 * Form-first routing test contract. Desktop transports the typed form request
 * to the daemon `task.settings.routingTest` method and renders the flattened
 * row projection; it never re-implements routing, scoring, or catalog
 * resolution. The snake_case wire DTO mirrors the daemon DTOs exactly.
 */

export type {
  TaskRoutingTestParams,
  TaskRoutingTestRow,
  TaskRoutingTestResult,
  TaskRoutingTestTask,
  TaskRoutingTestTasksResult,
};

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
/* ------------------------------------------------------------------ */
/* Bot agents                                                          */
/* ------------------------------------------------------------------ */

/**
 * A bot agent assembled from one bot directory. The daemon kernel owns
 * wake queues, contexts and model routing; Desktop only forwards allowlisted
 * `agent.*` and `routine.*` calls and renders their results.
 */
export type AgentStatus = 'idle' | 'running' | 'error' | 'disabled';

/** Where a bot definition lives: synced with the workspace, or this device only. */
export type { AgentBotLocation };

/** One file of a bot's memory directory, as listed read-only. */
export type { AgentMemoryFile };

export type AgentBot = AgentBotSummary;

export type RoutineState = 'active' | 'paused';

export type Routine = RoutineRecord;

/**
 * The exact daemon methods the shell bridge forwards. Any other method is
 * rejected before it can reach the daemon.
 */
export const AGENT_METHODS = [
  'agent.list',
  'agent.get',
  'agent.create',
  'agent.memory.list',
  'agent.events',
  'agent.wake',
  'agent.group.events',
  'agent.group.send',
  'routine.list',
  'routine.create',
  'routine.update',
  'routine.run',
  'routine.delete',
] as const;

export type AgentMethod = (typeof AGENT_METHODS)[number];
export type AgentMethodMap = AgentMethods & RoutineMethods;

export type {
  AgentListResult,
  AgentGetParams,
  AgentGetResult,
  AgentCreateParams,
  AgentCreateResult,
  AgentMemoryListParams,
  AgentMemoryListResult,
  AgentEventsParams,
  AgentWakeParams,
  AgentWakeResult,
};

/** Same shape as the daemon `session.events` result, for the bot context ledger. */
export interface AgentEventsResult { events: LedgerEvent[]; lastSeq: number }

/**
 * One entry of the shared group transcript, mirrored from the daemon
 * `group.mts` wire type. `seq` is the monotonic transcript cursor Desktop pages
 * with; a bot entry names the bot that spoke at publish time.
 */
export type {
  GroupMessage,
  AgentGroupEventsParams,
  AgentGroupEventsResult,
  AgentGroupSendParams,
  AgentGroupSendResult,
};

export type {
  RoutineListParams,
  RoutineListResult,
  RoutineCreateParams,
  RoutineCreateResult,
  RoutineUpdateParams,
  RoutineUpdateResult,
  RoutineRunParams,
  RoutineRunResult,
  RoutineDeleteParams,
  RoutineDeleteResult,
};


/* ------------------------------------------------------------------ */
/* Workspace todos                                                     */
/* ------------------------------------------------------------------ */

/**
 * Workspace todos are the bot's native task source: one Markdown file per todo
 * under the daemon-owned workspace `todos/` directory. The daemon owns the
 * files and every method; a caller names a todo and its fields, never where it
 * lives. These wire types mirror the daemon's workspace-todo DTOs exactly.
 */

/** The complete, ordered set of valid todo statuses. */
export type { TodoStatus };

/** One workspace todo, as stored in its Markdown file. */
export type { Todo };

/** Input for creating one workspace todo; the daemon generates the id. */
export type { TodoCreateInput };

/** Methods the Desktop todo UI forwards to the daemon as the user. */
export const TODO_METHODS = ['todo.list', 'todo.update', 'todo.tag', 'todo.untag', 'todo.comment', 'todo.uncomment'] as const;

export type TodoMethod = (typeof TODO_METHODS)[number];

/**
 * The mutation methods the separate bot-todo bridge forwards. They use their
 * own channel and allowlist, apart from the read-only `todo` facade.
 */
export const BOT_TODO_METHODS = ['todo.create', 'todo.update'] as const;

export type BotTodoMethod = (typeof BOT_TODO_METHODS)[number];

export type { TodoListParams, TodoListResult, TodoCreateParams, TodoCreateResult, TodoUpdateInput, TodoUpdateResult, TodoComment, TodoAddTagsInput, TodoRemoveTagInput, TodoAppendCommentInput, TodoDeleteCommentInput, TodoTagResult, TodoCommentResult };
/** `todo.update` takes the full protocol input including stale-text guards. */
export type TodoUpdateParams = TodoUpdateInput;

/** Params and result of each forwarded todo method, used to type the facade. */
export interface TodoMethodMap {
  'todo.list': { params: TodoListParams; result: TodoListResult };
  'todo.update': { params: TodoUpdateInput; result: TodoUpdateResult };
  'todo.tag': { params: TodoAddTagsInput; result: TodoTagResult };
  'todo.untag': { params: TodoRemoveTagInput; result: TodoTagResult };
  'todo.comment': { params: TodoAppendCommentInput; result: TodoCommentResult };
  'todo.uncomment': { params: TodoDeleteCommentInput; result: TodoCommentResult };
}

/** Params and result of each forwarded bot-todo method, used to type the facade. */
export interface BotTodoMethodMap {
  'todo.create': { params: TodoCreateParams; result: TodoCreateResult };
  'todo.update': { params: TodoUpdateParams; result: TodoUpdateResult };
}

/* ------------------------------------------------------------------ */
/* Agent clients                                                       */
/* ------------------------------------------------------------------ */

/**
 * The agent clients the daemon supports on its host, as reported by the
 * `client.list` method. These wire types mirror the daemon's client DTOs
 * exactly; Desktop never detects or installs a client itself.
 */
export type { ClientReadiness };

/** Host identity reported alongside a client list. */
export type { ClientListHost };

export type { ClientListEntry };

export type { ClientListResult };

/** A client lifecycle action the daemon can perform. */
export type { ClientAction };

export type { ClientActionParams };

export type { ClientActionResult };

/** The bounded daemon surface the shell `client` bridge forwards. */
export const CLIENT_METHODS = ['client.list', 'client.action'] as const;

export type ClientMethod = (typeof CLIENT_METHODS)[number];

/** Params and result of each forwarded client method, used to type the facade. */
export type ClientMethodMap = ClientMethods;

/* ------------------------------------------------------------------ */
/* Live task usage                                                     */
/* ------------------------------------------------------------------ */

export type { TaskUsageLive };

/** One pushed cumulative live-usage sample for a still-running gateway run. */
export interface TaskUsageLiveUpdate {
  /** Gateway execution identity backing the run, distinguishing parallel runs. */
  executionId: string;
  taskRunId: string;
  usage: TaskUsageLive;
}

/** The bounded daemon surface the shell `task` bridge forwards. */
export const TASK_METHODS = ['task.usage.liveList'] as const;

export type TaskMethod = (typeof TASK_METHODS)[number];

/** Params and result of each forwarded task method, used to type the facade. */
export interface TaskMethodMap {
  'task.usage.liveList': { params: TaskUsageLiveListParams; result: TaskUsageLiveListResult };
}

/* ------------------------------------------------------------------ */
/* WY Remote: SSH connection and single active context                 */
/* ------------------------------------------------------------------ */

/**
 * State of the single active daemon endpoint. `disconnected` is explicitly
 * *remote*-disconnected (a remote tunnel was lost): it never means the local
 * daemon took over, because remote and local are never both active.
 */
export type RemoteConnectionState = 'local' | 'connecting' | 'remote' | 'disconnected';

/** One remote host row: a saved host or a discovered local SSH host. */
export interface RemoteHostView {
  alias: string;
  displayName: string;
  /** Resolved address, or null when the fact is not yet known (never faked). */
  address: string | null;
  /** Remote OS (`darwin`/`win32`/`linux`) or null until honestly probed. */
  os: string | null;
}

/**
 * The active remote connection projection pushed to the renderer. Every emit
 * carries the committed connection generation, so a subscriber can key its own
 * reset on the generation (and drop a late push from a superseded switch)
 * instead of guessing from the state alone.
 */
export interface RemoteConnectionSnapshot {
  state: RemoteConnectionState;
  /** Monotonic committed-connection generation; bumps on every transition. */
  generation: number;
  host: { alias: string; displayName: string } | null;
  message?: string;
}

/**
 * Ephemeral SSH configuration candidate for the add-new form and for
 * silent/Test validation. It is never persisted from a probe; only a
 * successful Confirm appends a `Host` stanza.
 */
export interface RemoteConnectionTestInput {
  alias: string;
  host?: string;
  user?: string;
  port?: number;
  identityPath?: string;
  displayName?: string;
}

/** Outcome of a silent/Test validation; platform/arch are present on success. */
export interface RemoteConnectionTestResult {
  ok: boolean;
  platform?: string | null;
  arch?: string | null;
  message?: string;
}

/**
 * Outcome of a confirm/rename/connect/return mutation. Kept local: the
 * protocol `RemoteHostMutationResult` is a `RemoteHostListResult` (a fresh
 * saved-host list), while the Desktop bridge contract resolves with an
 * `ok`/`message` acknowledgement.
 */
export interface RemoteHostMutationResult {
  ok: boolean;
  message?: string;
}

export interface RemoteHostListResult {
  hosts: RemoteHostView[];
}

/* ------------------------------------------------------------------ */
/* Operation components                                                */
/* ------------------------------------------------------------------ */

/**
 * Operation components are machine-local capabilities the daemon owns for the
 * machine it runs on: a browser CLI (`agent-browser`) and a desktop-control MCP
 * driver (Cua Driver). The daemon installs, authorizes and health-checks them;
 * Desktop is only a transport/UI client. These wire types mirror the daemon's
 * `components.*` snapshots exactly so the preload facade, main handlers and
 * renderer read one definition.
 */
export type { OperationComponentId };

export type { OperationComponentState };

export type { OperationComponentAction };

export type { OperationComponentHint };

/** Staged progress of an in-flight component action. */
export type OperationComponentProgress = NonNullable<OperationComponentSnapshot['progress']>;

/**
 * One operation component snapshot, aliased to the protocol shape. The
 * protocol additionally carries an optional `runtimePresent` flag the
 * Desktop surface ignores; the extra optional field is additive only.
 */
export type { OperationComponentSnapshot };

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
  /** Open a frameless mini card for a session id; '' opens a new draft chat. */
  openMiniCard(sessionId: string): Promise<void>;
  /** Close the sender card and bring the shell back, opened to `sessionId`. */
  restoreMain(sessionId: string, command?: NotificationCommandAction): Promise<void>;
  /** Toggle always-on-top for the sender mini card (the 置顶 switch). */
  setAlwaysOnTop(enabled: boolean): Promise<void>;
  /** Close the sender mini card through the native close flow. */
  closeWindow(): Promise<void>;
  onWindowStateChanged(listener: (state: WindowStateSnapshot) => void): () => void;
  getSettings(): Promise<SettingsSnapshot>;
  getGatewaySettings(): Promise<WrenyardGatewaySettings>;
  saveGatewaySettings(input: WrenyardGatewaySettingsSaveInput): Promise<WrenyardGatewaySettingsSaveResult>;
  getGatewayHealth(): Promise<WrenyardGatewayHealthResult>;
  getStats(): Promise<StatsSnapshot>;
  getQuota(forceRefresh?: boolean): Promise<QuotaSnapshot>;
  /** Read-only data-directory usage from the connected daemon; `refresh` starts a new scan. */
  getStorageUsage(refresh?: boolean): Promise<StorageUsageSnapshot>;
  saveProviderOrder(providerIds: string[]): Promise<QuotaSnapshot>;
  /**
   * Publish the quota provider of the model currently selected in the composer
   * so Pet can focus it; `null` clears the focus (session unmounted). Optional
   * on the facade so a preload without the handler stays type-compatible.
   */
  setQuotaFocus?(focus: QuotaFocus | null): Promise<void>;
  configureProviderKey(providerId: string, key: string): Promise<QuotaSnapshot>;
  openProviderKeyPage(providerId: string): Promise<void>;
  /**
   * Start (or re-bind) a provider's native login through the daemon's
   * `provider.signIn` method. `switchAccount` replaces the stored login only
   * after the replacement is actually obtained (a completed browser login or a
   * usable desktop re-import): a failed or cancelled switch keeps the previous
   * login and its derived caches bound; `source` picks browser
   * re-authentication (default) or a re-import of the desktop client's own
   * login. Resolves with the daemon's own result: an auth URL to open when the
   * account is not bound yet, and an `alreadySignedIn` flag that marks an
   * existing login. Optional on the facade so a preload without the handler
   * stays type-compatible.
   */
  signInProvider?(
    providerId: string,
    options?: { switchAccount?: boolean; source?: 'browser' | 'desktop' },
  ): Promise<ProviderSignInResult>;
  getUpdate(): Promise<UpdateSnapshot>;
  checkUpdate(): Promise<UpdateSnapshot>;
  requestInstall(): Promise<UpdateSnapshot>;
  getDaemon(): Promise<DaemonLifecycleSnapshot>;
  startDaemon(): Promise<DaemonLifecycleSnapshot>;
  restartDaemon(): Promise<DaemonLifecycleSnapshot>;
  onDaemonChanged(listener: () => void): () => void;
  /** Fired after the daemon event subscription reconnects; live usage is rehydrated in one batch. */
  onTaskUsageReconnect(listener: () => void): () => void;
  /** Latest shared activity projection for the status bar (chrome spec 4.4). */
  getActivityStatus(): Promise<ActivityStatusSnapshot>;
  /** Pushed only when the projected activity content changes. */
  onActivityChanged(listener: (snapshot: ActivityStatusSnapshot) => void): () => void;
  savePetSettings(settings: PetCompanionSettings): Promise<SettingsSnapshot>;
  /**
   * Apply a workspace change through the daemon's `workspace.switch` method
   * while the daemon keeps running. `create` initializes a new (or empty)
   * directory first; the daemon then rebinds every workspace-scoped service,
   * persists `workspace.root` and returns its structured outcome. Resolves with
   * the refreshed workspace snapshot when the switch succeeded, and rejects with
   * the daemon's own busy/invalid/shutting-down/pinned reason otherwise — Desktop
   * never prewrites config on a refused or failed switch.
   */
  saveWorkspace(path: string, create?: boolean): Promise<WorkspaceConfigurationSnapshot>;
  openTaskTranscript(taskRunId: string, title?: string): Promise<void>;
  /** Open the native Graph Slip window for a live task graph (never a transcript). */
  openTaskGraph(taskGraphId: string): Promise<void>;
  copyText(text: string): Promise<void>;
  /** Open an `http:`/`https:` URL in the OS browser; other schemes are rejected. */
  openExternal(url: string): Promise<void>;
  onQuotaChanged(listener: () => void): () => void;
  onUpdateChanged(listener: () => void): () => void;
  onViewChanged(listener: (page: ShellPage) => void): () => void;
  getTaskSettings(project?: string, taskId?: string): Promise<TaskSettingsSnapshot>;
  getTaskDefinitionList(project?: string): Promise<TaskDefinitionListResult>;
  saveTaskSettings(request: TaskSettingsSaveRequest): Promise<TaskSettingsSnapshot>;
  /**
   * Forward one allowlisted `todo.*` read call to the daemon. The main-process
   * registrar rejects any method outside {@link TODO_METHODS}, so this facade
   * exposes only the bounded read-only `todo.list` method.
   */
  todo<M extends TodoMethod>(
    method: M,
    params?: TodoMethodMap[M]['params'],
  ): Promise<TodoMethodMap[M]['result']>;
  /**
   * Forward one allowlisted bot-todo mutation to the daemon. The main-process
   * registrar rejects any method outside {@link BOT_TODO_METHODS}; mutations
   * have their own channel and allowlist.
   */
  botTodo<M extends BotTodoMethod>(
    method: M,
    params?: BotTodoMethodMap[M]['params'],
  ): Promise<BotTodoMethodMap[M]['result']>;
  /**
   * Forward one allowlisted `agent.*`/`routine.*` call to the daemon. The
   * main-process registrar rejects any method outside {@link AGENT_METHODS}
   * before it reaches the daemon, so this facade is the renderer's only path
   * to bot agents.
   */
  agent<M extends AgentMethod>(
    method: M,
    params?: AgentMethodMap[M]['params'],
  ): Promise<AgentMethodMap[M]['result']>;
  /**
   * Forward one allowlisted `client.*` read call to the daemon. The
   * main-process registrar rejects any method outside {@link CLIENT_METHODS},
   * so this facade exposes only the read-only `client.list` method.
   */
  client<M extends ClientMethod>(
    method: M,
    params?: ClientMethodMap[M]['params'],
  ): Promise<ClientMethodMap[M]['result']>;
  /**
   * Forward one allowlisted `task.usage.*` call to the daemon. The
   * main-process registrar rejects any method outside {@link TASK_METHODS};
   * currently only the batched live-usage read is exposed.
   */
  task<M extends TaskMethod>(
    method: M,
    params?: TaskMethodMap[M]['params'],
  ): Promise<TaskMethodMap[M]['result']>;
  /**
   * Pushed cumulative live-usage samples for still-running gateway task runs.
   * No replay: callers hydrate through `task.usage.liveList` on mount or
   * reconnect; the returned function unsubscribes.
   */
  onTaskUsageLive(listener: (update: TaskUsageLiveUpdate) => void): () => void;
  requestTaskRoutingTest(params: TaskRoutingTestParams): Promise<TaskRoutingTestResult>;
  requestRoutingTestTasks(): Promise<TaskRoutingTestTasksResult>;
  execStart(request: ExecStartRequest): Promise<ExecSnapshotDto>;
  execGet(id: string): Promise<ExecSnapshotDto>;
  execEvents(request: ExecEventsRequest): Promise<ExecEventsResult>;
  execCancel(id: string): Promise<ExecCancelResult>;
  /** Subscribe to a main-process notification show. */
  onNotificationShow(listener: (notification: AppNotification) => void): () => void;
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
  /** The active remote connection state (WY Remote). */
  getRemoteConnection(): Promise<RemoteConnectionSnapshot>;
  /** Saved remote hosts, owned by the daemon config, not Desktop settings. */
  listRemoteHosts(): Promise<RemoteHostListResult>;
  /** Concrete hosts discovered from the local SSH configuration. */
  listDiscoveredSshHosts(): Promise<RemoteHostListResult>;
  /** Ephemeral silent/Test validation of a candidate SSH configuration. */
  testRemoteConnection(input: RemoteConnectionTestInput): Promise<RemoteConnectionTestResult>;
  /** Validate, provision if needed, connect and remember the host. */
  confirmRemoteConnection(input: RemoteConnectionTestInput): Promise<RemoteHostMutationResult>;
  /** Rename one saved host's display name in the daemon config. */
  renameRemoteHost(alias: string, displayName: string): Promise<RemoteHostMutationResult>;
  /** Connect a saved host directly, without re-adding or reinstalling. */
  connectSavedRemoteHost(alias: string): Promise<RemoteHostMutationResult>;
  /** Explicit return to the local endpoint; refreshes every view. */
  returnToLocal(): Promise<RemoteHostMutationResult>;
  /** Pushed after every committed connection-state change. */
  onRemoteChanged(listener: (snapshot: RemoteConnectionSnapshot) => void): () => void;
  /** Operation components installed on the daemon's machine. */
  getOperationComponents(): Promise<OperationComponentSnapshot[]>;
  /** Run one user-triggered component action; resolves with the updated snapshot. */
  runOperationComponentAction(
    id: OperationComponentId,
    action: OperationComponentAction,
  ): Promise<OperationComponentSnapshot>;
}

export function isShellPage(value: unknown): value is ShellPage {
  return value === 'session' || value === 'trace' || value === 'stats' || value === 'settings' || value === 'tasks' || value === 'agents' || value === 'routines' || value === 'todo';
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
  if (input.key === '2') return 'trace';
  if (input.key === '3') return 'stats';
  if (input.key === '5') return 'tasks';
  if (input.key === '6') return 'agents';
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
  { category: '导航', title: '追踪', mac: '⌘2', other: 'Ctrl+2', scope: '全局', page: 'trace' },
  { category: '导航', title: '工房台账', mac: '⌘3', other: 'Ctrl+3', scope: '全局', page: 'stats' },
  { category: '导航', title: '任务', mac: '⌘5', other: 'Ctrl+5', scope: '全局', page: 'tasks' },
  { category: '导航', title: '机器人', mac: '⌘6', other: 'Ctrl+6', scope: '全局', page: 'agents' },
  { category: '导航', title: '设置', mac: '⌘,', other: 'Ctrl+,', scope: '全局', page: 'settings' },
  { category: '导航', title: '后退', mac: '⌘[', other: 'Alt+←', scope: '全局', command: 'nav.back' },
  { category: '导航', title: '前进', mac: '⌘]', other: 'Alt+→', scope: '全局', command: 'nav.forward' },
  { category: '视图', title: '切换侧栏', mac: '⌘B', other: 'Ctrl+B', scope: '全局', command: 'view.toggleSidebar' },
  { category: '视图', title: '实际大小', mac: '⌘0', other: 'Ctrl+0', scope: '全局' },
  { category: '视图', title: '放大', mac: '⌘+', other: 'Ctrl++', scope: '全局' },
  { category: '视图', title: '缩小', mac: '⌘-', other: 'Ctrl+-', scope: '全局' },
  { category: '视图', title: '全屏', mac: '⌃⌘F', other: 'F11', scope: '全局' },
  { category: '会话', title: '搜索会话', mac: '⌘K', other: 'Ctrl+K', scope: '会话页' },
  { category: '会话', title: '新建对话', mac: '⌘N', other: 'Ctrl+N', scope: '全局', command: 'session.newDraft' },
  { category: '会话', title: '发送消息', mac: 'Enter', other: 'Enter', scope: '输入框' },
  { category: '会话', title: '换行', mac: '⇧Enter', other: 'Shift+Enter', scope: '输入框' },
  { category: '编辑', title: '撤销', mac: '⌘Z', other: 'Ctrl+Z', scope: '全局' },
  { category: '编辑', title: '重做', mac: '⇧⌘Z', other: 'Ctrl+Y', scope: '全局' },
  { category: '编辑', title: '剪切', mac: '⌘X', other: 'Ctrl+X', scope: '全局' },
  { category: '编辑', title: '复制', mac: '⌘C', other: 'Ctrl+C', scope: '全局' },
  { category: '编辑', title: '粘贴', mac: '⌘V', other: 'Ctrl+V', scope: '全局' },
  { category: '编辑', title: '全选', mac: '⌘A', other: 'Ctrl+A', scope: '全局' },
  { category: '窗口', title: '最小化', mac: '⌘M', scope: '全局' },
  { category: '窗口', title: '关闭窗口', mac: '⌘W / ⌃W', other: 'Ctrl+W', scope: '全局' },
  { category: '应用', title: '隐藏啾啾工坊', mac: '⌘H', scope: '全局' },
  { category: '应用', title: '隐藏其他', mac: '⌥⌘H', scope: '全局' },
  { category: '应用', title: '检查更新', mac: '⇧⌘U', other: 'Ctrl+Shift+U', scope: '全局' },
  { category: '应用', title: '退出', mac: '⌘Q（连按两次）', other: 'Ctrl+Q', scope: '全局' },
];

/** Platform key text for one shortcut, or null when it does not apply. */
export function knownShortcutKeys(shortcut: KnownShortcut, platform: NodeJS.Platform): string | null {
  return platform === 'darwin' ? shortcut.mac ?? null : shortcut.other ?? null;
}
