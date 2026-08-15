import { SiteSnapshot, WorkerView } from './snapshot';
import type { InfoCard } from '../main/hover-controller';

export type HouseSkinId = 'classic' | 'mushroom';

export interface RendererConfig {
  scale: number;
}

export interface HouseRendererState {
  scale: number;
  houseSkin: HouseSkinId;
  /** Visible house origin inside the transparent carrier, in CSS pixels. */
  placement?: { x: number; y: number };
  workers: WorkerView[];
  queuedCount: number;
  broadcast?: SiteSnapshot['broadcast'];
  dailyStats?: SiteSnapshot['dailyStats'];
  dailyStatsUnavailable?: boolean;
  quotaTips?: QuotaTipLine[];
  /** Last activity snapshot round failed; keep counts, show signal-lost. */
  activityStale?: boolean;
  /** Non-terminal TaskGraph drawing count from the same activity snapshot. */
  taskgraphCount?: number;
}

export interface WorkerRendererState {
  scale: number;
  worker: WorkerView;
  infoCard: InfoCard;
}

export interface DailyStatsEntry {
  dayKey: string;
  startAt: string;
  endAt: string;
  dispatchCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: 'sqlite';
  outcomes?: OutcomeCounts;
}

export interface OutcomeCounts {
  done: number;
  failed: number;
  cancelled: number;
}

export interface TodayStats {
  dayKey: string;
  startAt: string;
  endAt: string;
  dispatchCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: 'sqlite';
  outcomes?: OutcomeCounts;
}

export interface ProfileRankRow {
  profile: string;
  dispatchCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TaskRankRow {
  taskName: string;
  dispatchCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SummaryStatsTaskDurationRow {
  taskName: string;
  durationMs: number;
}

/** Task-source classification. Only byBuiltinTask is the filtered truth;
 *  task source is never inferred from project or id heuristics. */
export type StatsTaskSource = 'builtin' | 'project' | 'unknown';

export interface StatsWindowProfileRow {
  profile: string;
  runCount: number;
  totalTokens: number;
  /** Optional finite average tokens-per-second; absent means unavailable. */
  averageTps?: number;
}

export interface StatsWindowTaskRow {
  taskId: string;
  source: StatsTaskSource;
  runCount: number;
  durationMs: number;
}

export interface StatsWindowBuiltinTaskRow {
  taskId: string;
  runCount: number;
  durationMs: number;
}

export interface StatsWindowTaskStats {
  totalDurationMs: number;
  byTask: StatsWindowTaskRow[];
  builtinTotalDurationMs: number;
  byBuiltinTask: StatsWindowBuiltinTaskRow[];
}

/** One exact period window from stats.summary.windows (24h/7d/1mo). */
export interface StatsWindow {
  period: '24h' | '7d' | '1mo';
  startAt: string;
  endAt: string;
  dispatchCount: number;
  totalTokens: number;
  byProfile: StatsWindowProfileRow[];
  taskStats: StatsWindowTaskStats;
}

export interface SummaryStats {
  daily: DailyStatsEntry[];
  source?: string;
  today?: TodayStats;
  byProfile?: ProfileRankRow[];
  byTask?: TaskRankRow[];
  /** Optional atomic timing capability, additive and transient — never
   *  persisted into DailyStatsSnapshot or settings. */
  totalTaskDurationMs?: number;
  byTaskDuration?: SummaryStatsTaskDurationRow[];
  /** Optional exact 24h/7d/1mo window capability, validated atomically. */
  windows?: StatsWindow[];
}

export interface QuotaWindowRow {
  name: string;
  usedPct: number;
  remainingPct: number;
  expectedRemainingPct: number | null;
}

export interface QuotaProviderBars {
  remainingPct: number | null;
  expectedRemainingPct: number | null;
  windows: QuotaWindowRow[];
}

/** Shared quota provider/bar status. `pending` is included so Forge
 *  authentication-pending states type-check generically without
 *  provider-specific branching. */
export type QuotaProviderStatus = 'ok' | 'pending' | 'error' | 'unavailable';

export interface QuotaBarRow {
  provider: QuotaProviderBars;
  label: string;
  error: string | null;
  status: QuotaProviderStatus;
  stale: boolean;
}

export interface QuotaProviderState {
  id: string;
  label: string;
  displayLine: string | null;
  error: string | null;
  status: QuotaProviderStatus;
  stale: boolean;
  /** Passive Forge-provided code metadata (e.g. `authentication_pending`).
   *  Informational only; it must never trigger actions. */
  code?: string | null;
  /** Parsed window data for graphical rendering */
  bars?: QuotaProviderBars;
}

export interface QuotaTipLine {
  text: string;
  /** Structured bar data for graphical rendering in hover tips */
  bars?: QuotaBarRow[];
  /** Optional structured provider error row for two-column rendering */
  errorRow?: { label: string; message: string };
}

export interface QuotaDisplayRow {
  text: string;
  label?: string;
  error?: string;
  allocation: 'full' | 'split';
}

export interface HouseVisualHoverAction {
  label: string;
  action: string;
}

export interface HouseVisualState {
  activeWorkerCount: number;
  runningWorkerCount: number;
}
