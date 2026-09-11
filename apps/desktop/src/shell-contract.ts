import type { PetSettingsPayload } from '@wrenyard/pet/config';
import type {
  ClientConfigurationDto,
  ClientConfigurationId,
  ClientConfigurationPlanDto,
  ClientConfigurationSnapshotDto,
  ClientModelSelectionDto,
} from './client-configuration/contract.js';

export const ACTIVITY_BAR_WIDTH = 48;

export const SHELL_CHANNELS = {
  navigate: 'wrenyard-shell:navigate',
  settingsSnapshot: 'wrenyard-shell:settings-snapshot',
  statsSnapshot: 'wrenyard-shell:stats-snapshot',
  quotaSnapshot: 'wrenyard-shell:quota-snapshot',
  saveProviderOrder: 'wrenyard-shell:save-provider-order',
  savePetSettings: 'wrenyard-shell:save-pet-settings',
  saveWorkspace: 'wrenyard-shell:save-workspace',
  conversationSnapshot: 'wrenyard-shell:conversation-snapshot',
  conversationSelect: 'wrenyard-shell:conversation-select',
  conversationCreate: 'wrenyard-shell:conversation-create',
  conversationSelectModel: 'wrenyard-shell:conversation-select-model',
  conversationSend: 'wrenyard-shell:conversation-send',
  conversationCancel: 'wrenyard-shell:conversation-cancel',
  configureProviderKey: 'wrenyard-shell:configure-provider-key',
  clientConfigurationSnapshot: 'wrenyard-shell:client-configuration-snapshot',
  clientConfigurationPlan: 'wrenyard-shell:client-configuration-plan',
  clientConfigurationApply: 'wrenyard-shell:client-configuration-apply',
  clientConfigurationPlanRestore: 'wrenyard-shell:client-configuration-plan-restore',
  clientConfigurationRestore: 'wrenyard-shell:client-configuration-restore',
  updateSnapshot: 'wrenyard-shell:update-snapshot',
  checkUpdate: 'wrenyard-shell:check-update',
  setUpdateChannel: 'wrenyard-shell:set-update-channel',
  requestInstall: 'wrenyard-shell:request-install',
  cancelPendingInstall: 'wrenyard-shell:cancel-pending-install',
  conversationChanged: 'wrenyard-shell:conversation-changed',
  quotaChanged: 'wrenyard-shell:quota-changed',
  updateChanged: 'wrenyard-shell:update-changed',
  viewChanged: 'wrenyard-shell:view-changed',
  taskSettingsSnapshot: 'wrenyard-shell:task-settings-snapshot',
  taskSettingsSave: 'wrenyard-shell:task-settings-save',
  runtimeAliasSnapshot: 'wrenyard-shell:runtime-alias-snapshot',
  runtimeAliasPut: 'wrenyard-shell:runtime-alias-put',
  runtimeAliasRemove: 'wrenyard-shell:runtime-alias-remove',
  taskRoutingTest: 'wrenyard-shell:task-routing-test',
  taskRoutingTestTasks: 'wrenyard-shell:task-routing-test-tasks',
} as const;

export type ShellPage = 'workbench' | 'stats' | 'quota' | 'clients' | 'settings' | 'tasks';

export interface ServiceSnapshot {
  status: 'connected' | 'unavailable';
  endpoint: string;
  workspace: WorkspaceConfigurationSnapshot;
  uptimeMs?: number;
}

export interface WorkspaceConfigurationSnapshot {
  status: 'configured' | 'missing' | 'invalid';
  source: 'environment' | 'user-config' | 'none';
  configPath: string;
  path?: string;
  message?: string;
  readOnly: boolean;
}

export interface ModelSnapshot {
  id: string;
  label: string;
  configured: boolean;
}

export type UpdateChannel = 'stable' | 'dev';

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'stable-unavailable'
  | 'available'
  | 'preparing'
  | 'waiting'
  | 'installing'
  | 'install-blocked'
  | 'check-failed'
  | 'install-failed';

export interface UpdateSnapshot {
  channel: UpdateChannel;
  state: UpdateState;
  currentVersion: string;
  availableVersion?: string;
  checkedAt?: number;
  installSupported: boolean;
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
    dshVersion: string;
    buildTime?: string;
    channel: UpdateChannel;
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

export interface StatsRankingSnapshot {
  /** Canonical internal identity: a server `model` when provided, else the legacy `profile`/`taskName`. */
  name: string;
  /** Canonical model identity carried by newer payloads; absent on legacy profile-only rows. */
  model?: string;
  /** Exact unified Catalog model display label; absent when the server does not supply one. */
  modelDisplayName?: string;
  /** Exact Catalog provider display names backing this row, de-duplicated by the server. */
  providerDisplayNames?: string[];
  dispatchCount: number;
  totalTokens: number;
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
  source: 'summary' | 'today' | 'unavailable';
  today: StatsTodaySnapshot | null;
  daily: StatsDailySnapshot[];
  byProfile: StatsRankingSnapshot[];
  byTask: StatsRankingSnapshot[];
  windows: StatsWindowSnapshot[];
  recentTaskRuns: TaskRunSnapshot[];
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
  tpsContract?: 'response_v1';
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

export interface QuotaWindowSnapshot {
  name: string;
  remainingPct: number;
  expectedRemainingPct: number | null;
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

export interface ProviderAuthStatus {
  id: string;
  displayName?: string;
  description?: string;
  setupHint?: string;
  configured: boolean;
  authMode: ProviderAuthMode;
  models?: Array<{ id: string; displayName: string }>;
}

export interface ProviderCatalogSnapshot {
  id: string;
  label: string;
  description: string;
  configured: boolean;
  authMode: ProviderAuthMode;
  setupHint: string;
  quota?: QuotaProviderSnapshot;
  models?: Array<{ id: string; displayName: string }>;
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

export interface ConversationSessionSnapshot {
  id: string;
  title: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  agentPreset?: string;
}

export interface ConversationItemSnapshot {
  id: string;
  kind: 'user' | 'assistant' | 'tool';
  text: string;
  time: number;
  /** Stable DSH turn identity used to render one assistant message per turn. */
  turnId?: string;
  running?: boolean;
  reasoning?: string;
  toolName?: string;
  toolState?: 'running' | 'done' | 'failed';
  /** Bounded raw result text for the tool call, when CORE supplies one. */
  toolResultText?: string;
  /** Terminal run_task metadata, present only after the task run resolves. */
  taskRun?: TaskRunSnapshot;
}

export interface ConversationModelSelectionSnapshot {
  provider: string;
  /** Catalog Provider behind the DSH transport route. */
  catalogProvider: string;
  model: string;
  label: string;
  providerLabel: string;
  advertised: boolean;
  /** True when the current model's provider credentials were passed to DSH. */
  configured: boolean;
  reasoningEffort?: string;
}

export interface ConversationModelOptionSnapshot {
  provider: string;
  /** Catalog Provider behind the DSH transport route. */
  catalogProvider: string;
  providerLabel: string;
  model: string;
  label: string;
  description?: string;
  defaultReasoningEffort?: string;
  /**
   * Exact built-in Catalog input capabilities (`text`/`image`) projected for
   * this option. Derived from the authoritative Catalog model, never from DSH
   * claims or the model name. `undefined` means the capability is unknown —
   * the UI must not assume text-only for an unmatched model.
   */
  inputTypes?: readonly ('text' | 'image')[];
}

export interface ConversationModelGroupSnapshot {
  provider: string;
  label: string;
  models: ConversationModelOptionSnapshot[];
}

export interface ConversationModelsSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error';
  groups: ConversationModelGroupSnapshot[];
  current?: ConversationModelSelectionSnapshot;
  routable?: boolean;
  message?: string;
}

export interface ConversationSnapshot {
  status: 'ready' | 'workspace-required' | 'unavailable';
  workspace: WorkspaceConfigurationSnapshot;
  sessions: ConversationSessionSnapshot[];
  selectedSessionId?: string;
  selectedTitle?: string;
  selectedRunning: boolean;
  models: ConversationModelsSnapshot;
  hasMore: boolean;
  items: ConversationItemSnapshot[];
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
export interface TaskSettingsLayer {
  mode?: TaskSettingsMode;
  explicit_runtime?: TaskSettingsExplicitReference | null;
  timeout_ms?: number | null;
  /** Global-only auto-dispatch reference output cap (USD / million output tokens). 0 is valid; null clears; absent falls through. */
  max_auto_output_usd_per_million?: number | null;
  automatic?: Partial<TaskSettingsAutomaticDispatch> | null;
}

/** Field-level save patch; `null` deletes that field only at the selected layer. */
export interface TaskSettingsPatch {
  mode?: TaskSettingsMode | null;
  explicit_runtime?: TaskSettingsExplicitReference | null;
  timeout_ms?: number | null;
  /** Global-only reference output cap; null deletes only this field at the selected layer. */
  max_auto_output_usd_per_million?: number | null;
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

export interface WrenyardShellApi {
  platform: NodeJS.Platform;
  navigate(page: ShellPage): Promise<void>;
  getSettings(): Promise<SettingsSnapshot>;
  getStats(): Promise<StatsSnapshot>;
  getQuota(forceRefresh?: boolean): Promise<QuotaSnapshot>;
  saveProviderOrder(providerIds: string[]): Promise<QuotaSnapshot>;
  configureProviderKey(providerId: string, key: string): Promise<QuotaSnapshot>;
  getClientConfiguration(): Promise<ClientConfigurationSnapshotDto>;
  planClientConfiguration(clientId: ClientConfigurationId, selection: ClientModelSelectionDto): Promise<ClientConfigurationPlanDto>;
  applyClientConfiguration(plan: ClientConfigurationPlanDto): Promise<ClientConfigurationDto>;
  planClientConfigurationRestore(clientId: ClientConfigurationId): Promise<ClientConfigurationPlanDto>;
  restoreClientConfiguration(plan: ClientConfigurationPlanDto): Promise<ClientConfigurationDto>;
  getUpdate(): Promise<UpdateSnapshot>;
  checkUpdate(): Promise<UpdateSnapshot>;
  setUpdateChannel(channel: UpdateChannel): Promise<UpdateSnapshot>;
  requestInstall(): Promise<UpdateSnapshot>;
  cancelPendingInstall(): Promise<UpdateSnapshot>;
  savePetSettings(settings: PetCompanionSettings): Promise<SettingsSnapshot>;
  saveWorkspace(path: string): Promise<WorkspaceConfigurationSnapshot>;
  getConversation(): Promise<ConversationSnapshot>;
  selectConversation(sessionId: string): Promise<ConversationSnapshot>;
  createConversation(): Promise<ConversationSnapshot>;
  selectConversationModel(provider: string, model: string): Promise<ConversationSnapshot>;
  sendConversation(text: string, clientTimeZone?: string): Promise<ConversationSnapshot>;
  cancelConversation(): Promise<ConversationSnapshot>;
  onConversationChanged(listener: () => void): () => void;
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
}

export function isShellPage(value: unknown): value is ShellPage {
  return value === 'workbench' || value === 'stats' || value === 'quota' || value === 'clients' || value === 'settings' || value === 'tasks';
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
  if (input.key === '1') return 'workbench';
  if (input.key === '2') return 'stats';
  if (input.key === '3') return 'quota';
  if (input.key === '4') return 'clients';
  return null;
}
