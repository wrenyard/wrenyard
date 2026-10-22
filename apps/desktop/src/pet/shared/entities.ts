import { SiteSnapshot, WorkerView } from './snapshot';
import type { InfoCard } from '../main/model/hover-controller';

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
  /**
   * Display-only focus on the quota provider of the model currently selected in
   * the composer, carried from main to the overlay so the house card can surface
   * that provider. It is never a routing or storage key.
   */
  quotaFocus?: { id: string; label?: string };
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
  /** Declared pool label (display name or pool id); display-only, never a key. */
  poolLabel?: string;
  usedPct: number;
  remainingPct: number;
  expectedRemainingPct: number | null;
  /** Provider wire ISO reset time, carried for structured countdown rendering. */
  resetsAt?: string;
  /** Provider wire window length in minutes, carried for window labelling. */
  windowMinutes?: number;
}

export interface QuotaProviderBars {
  remainingPct: number | null;
  expectedRemainingPct: number | null;
  windows: QuotaWindowRow[];
}

/** Shared quota provider/bar status. `pending` is included so Wrenyard
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
  /** Explicit provider-reported account plan name; absent means unknown. */
  plan?: string;
  /** Sanitized login type the provider reported (e.g. `sso`); absent when the
   *  provider reports no login identity. Never derived from quota numbers. */
  accountType?: string;
  /** Sanitized identity provider of that login (e.g. `ioa_auth`); absent when
   *  the provider reports no login identity. */
  idp?: string;
  displayLine: string | null;
  error: string | null;
  status: QuotaProviderStatus;
  stale: boolean;
  /** Passive Wrenyard-provided code metadata (e.g. `authentication_pending`).
   *  Informational only; it must never trigger actions. */
  code?: string | null;
  /** Parsed window data for graphical rendering */
  bars?: QuotaProviderBars;
  /** Structured monetary and unit-denominated balances, distinct from
   *  percentage windows. */
  balances?: QuotaBalanceRow[];
  /**
   * Daemon-computed estimated USD spend per quota window (Devin only):
   * `{ window, models, totalUsd }` records keyed to a window name. Absent for
   * other providers and when no traffic was recorded.
   */
  estimatedSpend?: { window: string; models: Record<string, number>; totalUsd: number }[];
}

/**
 * A single quota balance row, separate from percentage bars. Monetary rows
 * carry `currency` + `amount`; a unit-denominated row carries a stable `id`,
 * a non-currency `unit` (e.g. `Credits`), a null amount when the provider
 * reported the balance slot without a value, and an optional `unlimited`
 * flag.
 */
export interface QuotaBalanceRow {
  /** Stable balance identity (e.g. `chatgpt/credits`); absent for monetary rows. */
  id?: string;
  /** Uppercase three-letter ISO currency code of a monetary row. */
  currency?: string;
  /** Non-negative decimal-string amount; null means reported-but-unknown. */
  amount: string | null;
  /** Non-currency display unit of a unit-denominated row. */
  unit?: string;
  /** Provider-declared unlimited balance. */
  unlimited?: boolean;
  /** Pre-formatted display value (e.g. `¥12.50`, `120 Credits`, `不限量`). */
  display: string;
}

export interface QuotaTipLine {
  text: string;
  /** Explicit provider-reported account plan name; absent means unknown. */
  plan?: string;
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
