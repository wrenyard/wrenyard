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
  docsList: 'wrenyard-shell:docs-list',
  docsRead: 'wrenyard-shell:docs-read',
  docsSave: 'wrenyard-shell:docs-save',
  docsDirty: 'wrenyard-shell:docs-dirty',
} as const;

export type ShellPage = 'workbench' | 'stats' | 'quota' | 'clients' | 'settings' | 'docs';

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
  name: string;
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
    name: string;
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
  source: 'local_31d' | 'catalog_default';
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
  agentTurnMs?: number;
  outputTps?: number;
  tpsContract?: 'agent_turn_v1';
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
  status?: 'done' | 'failed' | 'cancelled' | 'running';
  startedAt?: string;
  finishedAt?: string;
  resolvedClient?: string;
  resolvedProvider?: string;
  resolvedProfile?: string;
  resolvedModel?: string;
  resolvedModelId?: string;
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
}

export interface ProviderCatalogSnapshot {
  id: string;
  label: string;
  description: string;
  configured: boolean;
  authMode: ProviderAuthMode;
  setupHint: string;
  quota?: QuotaProviderSnapshot;
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

export interface WorkspaceDocEntry {
  path: string;
}

export interface WorkspaceDocContent {
  path: string;
  content: string;
}

export interface WorkspaceDocSaveResult {
  path: string;
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
  listDocs(): Promise<WorkspaceDocEntry[]>;
  readDoc(path: string): Promise<WorkspaceDocContent>;
  saveDoc(path: string, content: string, expectedContent: string): Promise<WorkspaceDocSaveResult>;
  setDocsDirty(dirty: boolean): Promise<void>;
}

export function isShellPage(value: unknown): value is ShellPage {
  return value === 'workbench' || value === 'stats' || value === 'quota' || value === 'clients' || value === 'settings' || value === 'docs';
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
