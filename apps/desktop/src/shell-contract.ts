import type { PetSettingsPayload } from '@wrenyard/pet/config';

export const ACTIVITY_BAR_WIDTH = 48;

export const SHELL_CHANNELS = {
  navigate: 'wrenyard-shell:navigate',
  settingsSnapshot: 'wrenyard-shell:settings-snapshot',
  statsSnapshot: 'wrenyard-shell:stats-snapshot',
  quotaSnapshot: 'wrenyard-shell:quota-snapshot',
  savePetSettings: 'wrenyard-shell:save-pet-settings',
  saveWorkspace: 'wrenyard-shell:save-workspace',
  conversationSnapshot: 'wrenyard-shell:conversation-snapshot',
  conversationSelect: 'wrenyard-shell:conversation-select',
  conversationCreate: 'wrenyard-shell:conversation-create',
  conversationSend: 'wrenyard-shell:conversation-send',
  conversationCancel: 'wrenyard-shell:conversation-cancel',
  conversationChanged: 'wrenyard-shell:conversation-changed',
  quotaChanged: 'wrenyard-shell:quota-changed',
  viewChanged: 'wrenyard-shell:view-changed',
} as const;

export type ShellPage = 'workbench' | 'stats' | 'quota' | 'settings';

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

export interface SettingsSnapshot {
  service: ServiceSnapshot;
  models: ModelSnapshot[];
  pet: PetCompanionSnapshot;
  about: {
    desktopVersion: string;
    wrenyardVersion: string;
    dshVersion: string;
    channel: 'development-preview';
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
}

export interface QuotaSnapshot {
  status: 'available' | 'unavailable';
  providers: QuotaProviderSnapshot[];
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
  running?: boolean;
  reasoning?: string;
  toolName?: string;
  toolState?: 'running' | 'done' | 'failed';
}

export interface ConversationSnapshot {
  status: 'ready' | 'workspace-required' | 'unavailable';
  workspace: WorkspaceConfigurationSnapshot;
  sessions: ConversationSessionSnapshot[];
  selectedSessionId?: string;
  selectedTitle?: string;
  selectedRunning: boolean;
  hasMore: boolean;
  items: ConversationItemSnapshot[];
  message?: string;
}

export interface WrenyardShellApi {
  navigate(page: ShellPage): Promise<void>;
  getSettings(): Promise<SettingsSnapshot>;
  getStats(): Promise<StatsSnapshot>;
  getQuota(forceRefresh?: boolean): Promise<QuotaSnapshot>;
  savePetSettings(settings: PetCompanionSettings): Promise<SettingsSnapshot>;
  saveWorkspace(path: string): Promise<WorkspaceConfigurationSnapshot>;
  getConversation(): Promise<ConversationSnapshot>;
  selectConversation(sessionId: string): Promise<ConversationSnapshot>;
  createConversation(): Promise<ConversationSnapshot>;
  sendConversation(text: string, clientTimeZone?: string): Promise<ConversationSnapshot>;
  cancelConversation(): Promise<ConversationSnapshot>;
  onConversationChanged(listener: () => void): () => void;
  onQuotaChanged(listener: () => void): () => void;
  onViewChanged(listener: (page: ShellPage) => void): () => void;
}

export function isShellPage(value: unknown): value is ShellPage {
  return value === 'workbench' || value === 'stats' || value === 'quota' || value === 'settings';
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
  return null;
}
