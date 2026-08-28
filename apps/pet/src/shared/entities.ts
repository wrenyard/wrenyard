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
  /** Structured monetary balances, distinct from percentage windows. */
  balances?: QuotaBalanceRow[];
}

/** A single monetary quota balance row, separate from percentage bars. */
export interface QuotaBalanceRow {
  /** Uppercase three-letter ISO currency code, e.g. `CNY` or `USD`. */
  currency: string;
  /** Non-negative decimal-string amount, e.g. `"12.50"`. */
  amount: string;
  /** Pre-formatted display value for the currency (e.g. `¥12.50`, `$12.50`). */
  display: string;
}

export interface QuotaTipLine {
  text: string;
  /** Structured bar data for graphical rendering in hover tips */
  bars?: QuotaBarRow[];
  /** Structured monetary balance rows, distinct from bars. */
  balances?: QuotaBalanceRow[];
  /** Explicit group identity for monetary balances (e.g. provider id), so
   *  renderers never infer the provider from balance text. */
  balanceLabel?: string;
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
