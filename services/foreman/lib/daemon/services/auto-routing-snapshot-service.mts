/**
 * Daemon-owned immutable quota snapshot service for automatic routing.
 *
 * This service is the single runtime place that turns raw `forge quota --json`
 * output into policy-shaped quota evidence for auto-routing. It deliberately
 * does NOT own any provider/model/pool/applicability mapping: binding
 * metadata is imported as PROVIDER_QUOTA_BINDINGS (@wrenyard/providers) and the
 * policy constraints/evidence shapes come from @wrenyard/catalog, so there is
 * exactly one canonical binding table and no duplicated policy types.
 *
 * Raw parsing is fail-closed against the real `forge quota --json` list DTO
 * emitted by runtime/forge/internal/usage/quota: each pool entry carries
 * `pool`, `status`, `stale`, a per-entry RFC3339 `fetched_at` and `windows`;
 * each window carries `name`, the raw USED `pct`, an ISO-string `resets_at`
 * and `window_minutes`. The raw output has NO `reset_kind`, `window_ms`,
 * numeric id or epoch timestamp fields, and nothing here invents them. The Go
 * quota DTO addresses a row by `provider` (not `pool`) and serializes
 * not-applicable windows as `not_applicable_windows`.
 *
 * Rules:
 *  - the raw window USED percent (`pct`) is authoritative and
 *    `remainingPercent = 100 - pct` is derived from it; the Go-side clamped
 *    `remaining_pct` is never consulted;
 *  - a finite out-of-range pct is preserved as an out-of-range remaining
 *    percent so the policy can reject it, never clamped into a healthy state;
 *  - ISO strings are accepted only through finite Date.parse results and
 *    `window_minutes` is converted to milliseconds (`* 60_000`);
 *  - missing/non-number pct, missing windows, non-ok rows, stale rows and
 *    rows whose fetched_at is missing, invalid, future or older than 60
 *    seconds all surface as { id, evidence: null } (genuinely unknown);
 *  - a raw row carries `provider` (the owner provider, e.g. cursor/chatgpt)
 *    and is located by `row.provider === binding.providerId`; a window is
 *    located by exact `name`;
 *  - replenishment semantics come exclusively from binding window
 *    constraints: `full_cycle`/`rolling_partial`/`unproven` map to
 *    `full_cycle`/`rolling_partial`/`unknown`. Full-cycle evidence carries the
 *    parsed reset time and cycle duration; rolling/unknown evidence never
 *    pretends to know a reset pace.
 *
 * Freshness and caching:
 *  - a normal row is usable only while status ok, stale false and fetched_at
 *    is valid, non-future and within the last 60 seconds. A direct snapshot is
 *    valid until the earliest raw freshness boundary (fetched_at + 60s),
 *    capped at now + 60s.
 *  - a successful report that yields no fresh usable binding evidence and no
 *    valid hard block becomes a short-lived unknown snapshot (never a 60s
 *    successful all-unknown cache).
 *
 * The only hard provider block produced here is the privacy-safe observed
 * CodeBuddy exhaustion signal projected by the neutral Go v2 list DTO: exact
 * pool `codebuddy`, status ok, stale false, one window whose name is exactly
 * `observed`, raw used pct exactly 100 and a finite future parsed `resets_at`.
 * The legacy monthly `1mo` window is inert and never blocks. Go intentionally
 * emits this retained negative row WITHOUT `fetched_at`, so it is validated
 * without one; its cache is bounded by min(now + 60s, reset). Absence, invalid
 * or expired observations stay unknown (never a block).
 *
 * Current-login scoping and caching:
 *  - on every snapshot() request the optional CodeBuddy active-snapshot loader
 *    is resolved afresh. Only a non-empty opaque stable scope plus its
 *    normalized environment forms the private CodeBuddy query context that is
 *    handed to the query source, and cached/in-flight entries are keyed by that
 *    exact context, so a token refresh on the same account reuses quota
 *    evidence while a login or environment change can never reuse cached or
 *    in-flight CodeBuddy state;
 *  - a missing or throwing snapshot, an absent stable scope, or a query failure
 *    fails closed: no CodeBuddy context is formed, no fallback is attempted,
 *    and no previous CodeBuddy block is reused;
 *  - only the expected scope/environment ever reaches the query source. The
 *    credential/token/domain/wire mapping stays inside the loader, and the
 *    scope/environment never appear in any serialized snapshot/DTO field.
 *
 * Out of scope by construction: prices, tariffs, credits, fallback routing and
 * credentials. No network logic lives in TypeScript; the default query spawns
 * the existing Foreman Forge helper (no shell, bounded timeout, capped
 * stdout/stderr) to run exactly `forge quota --json`. Output that exceeds the
 * caps terminates the child and is rejected, never parsed as truncated data.
 */

import { randomUUID } from 'node:crypto';

import { queryForgeQuotaJson, type CodeBuddyQueryContext } from '../execution/forge-quota-query.mts';

import type { BalanceEvidence, QuotaEvidence, RequiredQuotaConstraint, ReplenishmentKind } from '@wrenyard/catalog';
import { PROVIDER_QUOTA_BINDINGS } from '@wrenyard/providers';
/** Evidence freshness window for a direct raw observation (ms). */
const QUOTA_SNAPSHOT_VALID_FOR_MS = 60_000;

/** A snapshot may never claim direct freshness further than now + this cap. */
const DIRECT_FRESHNESS_CAP_MS = 60_000;

/** Validity of a fail-closed unknown snapshot (short-lived, never cached). */
const UNKNOWN_SNAPSHOT_VALID_MS = 15_000;

/** Cache key for snapshots with no complete CodeBuddy query context. */
const NO_CODEBUDDY_CONTEXT_KEY = '';

/**
 * The minimal immutable current CodeBuddy active snapshot view the service
 * consumes from its optional loader: the opaque stable scope and the normalized
 * environment of the current login. The provider runtime's active snapshot
 * satisfies this structurally; the service reads only these fields, never the
 * credential/token/domain/wire mapping, and the scope/environment never appear
 * in a serialized AutoRoutingQuotaSnapshot.
 */
export interface CodeBuddyActiveSnapshotView {
  readonly stableScope: string | undefined;
  readonly environment: string;
  /** Read-free canonical-to-wire resolution bound to this same auth read. */
  resolveUpstreamModel(model: string): string;
  /** Read-free confirmed-free evaluation bound to this same auth read. */
  freeSupply(model: string):
    | { readonly confirmedFree: true; readonly source: string; readonly ruleId: string }
    | undefined;
}

/** Deterministic private cache key for one CodeBuddy query context. */
function codeBuddyContextKey(context: CodeBuddyQueryContext | undefined): string {
  if (context === undefined) return NO_CODEBUDDY_CONTEXT_KEY;
  return `${context.expectedScope}\u0000${context.expectedEnvironment}`;
}

// ---------------------------------------------------------------------------
// Public snapshot shape
// ---------------------------------------------------------------------------

/** One binding entry in a snapshot with its frozen required quota constraints. */
export interface AutoRoutingQuotaSnapshotEntry {
  readonly providerId: string;
  readonly modelId: string;
  /** Every jointly required normalized pool id for this binding. */
  readonly quotaPoolIds: readonly string[];
  readonly requiredQuota: readonly RequiredQuotaConstraint[];
}

/**
 * Immutable automatic-routing quota snapshot.
 *
 * - `nowMs`: when this snapshot was taken.
 * - `validUntilMs`: the earliest direct freshness boundary (60s from each raw
 *   fetched_at) capped at now + 60s (or by the CodeBuddy reset for a retained
 *   hard block), or the short validity of an unknown snapshot. After this time
 *   a caller must obtain a new snapshot.
 * - `hardBlockedProviderIds`: monotonic privacy-safe observed CodeBuddy
 *   exhaustion blocks only.
 *
 * The private CodeBuddy query context (expected scope/environment) never
 * appears on the snapshot or in any serialized field.
 */
export interface AutoRoutingQuotaSnapshot {
  readonly snapshotId: string;
  readonly nowMs: number;
  readonly validUntilMs: number;
  readonly entries: readonly AutoRoutingQuotaSnapshotEntry[];
  readonly hardBlockedProviderIds: readonly string[];
}

/**
 * Private daemon routing bundle. The quota DTO remains serialization-safe;
 * the optional active CodeBuddy snapshot is retained only in-process so one
 * auth read can drive scope, environment, wire mapping and free eligibility.
 */
export interface AutoRoutingBoundQuotaSnapshot {
  readonly snapshot: AutoRoutingQuotaSnapshot;
  readonly codeBuddySnapshot: CodeBuddyActiveSnapshotView | undefined;
}

export interface AutoRoutingQuotaSnapshotServiceOptions {
  /** Query source for the raw `forge quota --json` text (defaults to the daemon
   *  spawn). Receives the current complete CodeBuddy expected scope/environment
   *  context when one exists, and undefined otherwise. */
  queryJson?: (context?: CodeBuddyQueryContext) => Promise<string>;
  /** Current time in epoch ms (defaults to Date.now). */
  now?: () => number;
  /** Optional async loader of the current immutable CodeBuddy active snapshot,
   *  resolved afresh on every snapshot() request. When it resolves to a
   *  non-empty stable scope plus a normalized environment, quota queries are
   *  scoped to that context and cache/in-flight evidence is keyed by it; a
   *  missing/throwing snapshot or absent stable scope fails closed with no
   *  CodeBuddy context. */
  codeBuddySnapshot?: () => Promise<CodeBuddyActiveSnapshotView | undefined>;
}

// ---------------------------------------------------------------------------
// Fail-closed raw report normalization (real Go list DTO)
// ---------------------------------------------------------------------------

interface RawWindow {
  readonly name: string | null;
  readonly pct: number | null;
  readonly resetsAtMs: number | null;
  readonly windowMs: number | null;
}

/** One raw Forge balance entry: a currency plus a decimal amount string. */
interface RawBalance {
  readonly currency: string | null;
  readonly amount: string | null;
}

interface RawRow {
  readonly provider: string | null;
  readonly status: string | null;
  readonly stale: boolean;
  readonly fetchedAtMs: number | null;
  readonly windows: readonly RawWindow[];
  /** Raw window names the provider explicitly declares not applicable. */
  readonly notApplicableWindows: readonly string[];
  readonly balances: readonly RawBalance[];
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Parses an ISO/RFC3339 string to epoch ms; only finite results are accepted. */
function isoTimeMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Converts raw `window_minutes` to ms; requires a finite positive number. */
function windowMinutesToMs(value: unknown): number | null {
  return finiteNumber(value) && value > 0 ? value * 60_000 : null;
}

/** Replenishment kind comes exclusively from the binding window constraint. */
function toReplenishmentKind(resetKind: unknown): ReplenishmentKind {
  if (resetKind === 'full_cycle') return 'full_cycle';
  if (resetKind === 'rolling_partial') return 'rolling_partial';
  return 'unknown';
}

function normalizeRow(item: unknown): RawRow | null {
  if (item === null || typeof item !== 'object') return null;
  const raw = item as Record<string, unknown>;

  const windows: RawWindow[] = [];
  if (Array.isArray(raw.windows)) {
    for (const entry of raw.windows) {
      if (entry === null || typeof entry !== 'object') continue;
      const window = entry as Record<string, unknown>;
      // Each window object is built exactly once with distinct keys so no
      // duplicate properties can ever be emitted downstream.
      windows.push({
        name: stringOrNull(window.name),
        pct: finiteNumber(window.pct) ? window.pct : null,
        resetsAtMs: isoTimeMs(window.resets_at),
        windowMs: windowMinutesToMs(window.window_minutes),
      });
    }
  }

  // Go serializes provider-declared not-applicable window names as
  // `not_applicable_windows`. Only a fresh ok row may use them to skip a pool.
  const notApplicableWindows: string[] = [];
  if (Array.isArray(raw.not_applicable_windows)) {
    for (const entry of raw.not_applicable_windows) {
      if (typeof entry === 'string') notApplicableWindows.push(entry);
    }
  }

  // Existing Forge balances source: raw `balances: [{ currency, amount }]` with
  // a decimal amount string. Never synthesized, never coerced to zero.
  const balances: RawBalance[] = [];
  if (Array.isArray(raw.balances)) {
    for (const entry of raw.balances) {
      if (entry === null || typeof entry !== 'object') {
        balances.push({ currency: null, amount: null });
        continue;
      }
      const balance = entry as Record<string, unknown>;
      balances.push({
        currency: stringOrNull(balance.currency),
        amount: stringOrNull(balance.amount),
      });
    }
  }

  return {
    provider: stringOrNull(raw.provider),
    status: stringOrNull(raw.status),
    stale: raw.stale === true,
    fetchedAtMs: isoTimeMs(raw.fetched_at),
    windows: Object.freeze(windows),
    notApplicableWindows: Object.freeze(notApplicableWindows),
    balances: Object.freeze(balances),
  };
}

/** Normalizes the raw report, or throws on malformed JSON (fail closed). */
function parseQuotaReport(text: string): readonly RawRow[] {
  const parsed: unknown = JSON.parse(text); // Throws -> refresh fails closed.
  const items: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).quota)
      ? ((parsed as Record<string, unknown>).quota as unknown[])
      : [];
  return Object.freeze(items.map(normalizeRow).filter((row): row is RawRow => row !== null));
}

// ---------------------------------------------------------------------------
// Snapshot building
// ---------------------------------------------------------------------------

function rowUsable(row: RawRow, nowMs: number): boolean {
  return (
    row.provider !== null &&
    row.status === 'ok' &&
    row.stale === false &&
    row.fetchedAtMs !== null &&
    row.fetchedAtMs <= nowMs &&
    row.fetchedAtMs + QUOTA_SNAPSHOT_VALID_FOR_MS > nowMs
  );
}

function findRow(rows: readonly RawRow[], providerId: string): RawRow | null {
  return rows.find((row) => row.provider === providerId) ?? null;
}

/**
 * One required-quota target derived from a binding's applicability metadata.
 *
 * Window-less markers (a quota pool with no proven raw windows) carry only
 * the normalized pool id: no windowName and no reset facts, so their evidence
 * stays null (unknown coverage) and an absent window/reset value can never
 * reach evidence construction.
 */
type RequiredQuotaTarget =
  | {
      readonly id: string;
      readonly windowName?: undefined;
      readonly resetKind?: undefined;
      readonly balanceId?: undefined;
    }
  | {
      readonly id: string;
      /** Exact raw window name on the provider row; present only when the pool
       *  has proven raw windows located by exact name. */
      readonly windowName: string;
      /** Replenishment semantics come exclusively from the binding window
       *  constraint; never invented from raw output. */
      readonly resetKind: unknown;
      readonly balanceId?: undefined;
    }
  | {
      /** Mandatory monetary balance resource; evidence is located by the raw
       *  Forge balances array on the same provider row. */
      readonly id: string;
      readonly balanceId: string;
      readonly windowName?: undefined;
      readonly resetKind?: undefined;
    };

interface BindingQuotaShape {
  readonly quotaPoolIds: string[];
  readonly targets: readonly RequiredQuotaTarget[];
}

/**
 * Expands a ProviderQuotaBinding into its required constraint targets.
 *
 * Every binding has exactly one shape: an ordered non-empty `pools` array.
 * Each pool contributes at least one required constraint keyed by its unique
 * `quotaPoolId`:
 *
 *  - a `balance` pool contributes one discriminated balance constraint, with
 *    evidence sourced from the same raw row's Forge `balances` array;
 *  - a `quota` pool contributes one target, unless its window is explicitly
 *    not applicable in a fresh authoritative provider response;
 *  - a `quota` pool with no proven raw windows always contributes exactly one
 *    constraint keyed by `quotaPoolId`, so coverage stays incomplete/unknown.
 *
 * A pool is skipped ONLY when the binding's provider row is fresh/ok and
 * explicitly lists the pool's actual window in `not_applicable_windows`. Any
 * malformed, stale, missing or unknown row always contributes a null
 * constraint (never an absent one).
 */
function quotaShapeOf(binding: {
  readonly providerId: string;
  readonly pools: readonly {
    readonly quotaPoolId: string;
    readonly kind: string;
    readonly windows: readonly { readonly windowId: string; readonly resetKind: unknown }[];
    readonly balanceId?: string;
  }[];
}, row: RawRow | null, nowMs: number): BindingQuotaShape {
  const quotaPoolIds: string[] = [];
  const targets: RequiredQuotaTarget[] = [];
  for (const pool of binding.pools) {
    const window = pool.windows[0];
    // Every pool represents one resource, so every applicable pool contributes once.
    if (window && row && rowUsable(row, nowMs)
      && row.notApplicableWindows.includes(window.windowId)
      && !row.windows.some((item) => item.name === window.windowId)) continue;
    quotaPoolIds.push(pool.quotaPoolId);
    if (pool.kind === 'balance') {
      targets.push({ id: pool.quotaPoolId, balanceId: pool.quotaPoolId });
    } else if (window) {
      targets.push({ id: pool.quotaPoolId, windowName: window.windowId, resetKind: window.resetKind });
    } else {
      targets.push({ id: pool.quotaPoolId });
    }
  }
  return { quotaPoolIds, targets };
}

/** Builds the immutable entry fields for a binding from its required quota. */
function entryFields(
  binding: { readonly providerId: string; readonly modelId: string },
  shape: BindingQuotaShape,
  requiredQuota: RequiredQuotaConstraint[],
): AutoRoutingQuotaSnapshotEntry {
  return {
    providerId: binding.providerId,
    modelId: binding.modelId,
    quotaPoolIds: shape.quotaPoolIds,
    requiredQuota,
  };
}

function windowEvidence(row: RawRow, windowName: string, resetKind: unknown): QuotaEvidence | null {
  const rawWindow = row.windows.find((window) => window.name === windowName);
  if (rawWindow === undefined || rawWindow.pct === null) return null;
  const observedAtMs = row.fetchedAtMs;
  if (observedAtMs === null) return null;
  const replenishmentKind = toReplenishmentKind(resetKind);
  // Raw USED pct is authoritative. remainingPercent = 100 - pct is derived and
  // a finite out-of-range pct is preserved (never the Go-clamped remaining_pct).
  const remainingPercent = 100 - rawWindow.pct;
  // A fresh explicit zero proves exhaustion even when cycle metadata is absent.
  if (remainingPercent === 0) {
    return { remainingPercent, observedAtMs, validForMs: QUOTA_SNAPSHOT_VALID_FOR_MS, replenishmentKind };
  }
  if (replenishmentKind === 'full_cycle') {
    // Full-cycle evidence carries the parsed reset time and cycle duration.
    if (rawWindow.resetsAtMs === null || rawWindow.windowMs === null) return null;
    return {
      remainingPercent,
      observedAtMs,
      validForMs: QUOTA_SNAPSHOT_VALID_FOR_MS,
      replenishmentKind,
      resetAtMs: rawWindow.resetsAtMs,
      windowMs: rawWindow.windowMs,
    };
  }
  // rolling_partial/unknown carry no reset pace.
  return { remainingPercent, observedAtMs, validForMs: QUOTA_SNAPSHOT_VALID_FOR_MS, replenishmentKind };
}

/**
 * Builds discriminated monetary balance evidence for one mandatory balance
 * resource from the raw Forge balances array on the same row.
 *
 * Only a usable row with a fresh observation yields evidence: any valid positive
 * balance keeps the account available (all must be valid to claim all-zero).
 * Nothing here synthesizes a percentage, reset period, free-supply fact, FX rate
 * or guaranteed affordability from money; malformed/absent amounts surface as
 * the raw string (or null) so the policy treats them as unknown, never zero.
 */
function balanceEvidence(row: RawRow): BalanceEvidence | null {
  if (row.fetchedAtMs === null || row.balances.length === 0) return null;
  let positive: string | undefined;
  let allValid = true;
  for (const entry of row.balances) {
    if (entry.currency === null || !/^[A-Z]{3}$/.test(entry.currency) || entry.amount === null || !/^\d+(?:\.\d+)?$/.test(entry.amount)) {
      allValid = false;
      continue;
    }
    if (/[1-9]/.test(entry.amount)) positive ??= entry.amount;
  }
  // Currencies are alternative balances, not amounts to add or convert.
  // One valid positive suffices; claim zero only when every entry is valid.
  if (positive === undefined && !allValid) return null;
  return { amount: positive ?? '0', observedAtMs: row.fetchedAtMs, validForMs: QUOTA_SNAPSHOT_VALID_FOR_MS };
}

/**
 * The CodeBuddy retained negative reset time, or null when it is invalid.
 *
 * Matches the exact neutral Go v2 projection: pool `codebuddy`, status ok,
 * stale false, one window whose name is exactly `observed`, raw used pct
 * exactly 100 and a finite future parsed `resets_at`. The legacy monthly
 * `1mo` window is inert and never blocks.
 */
function codebuddyExhaustionReset(row: RawRow): number | null {
  if (row.provider !== 'codebuddy') return null;
  if (row.status !== 'ok') return null;
  if (row.stale !== false) return null;
  const observed = row.windows.find((window) => window.name === 'observed');
  if (observed === undefined) return null;
  if (observed.pct !== 100) return null;
  return observed.resetsAtMs; // Validated as finite-future by the caller.
}

function buildUnknownSnapshot(nowMs: number, rows: readonly RawRow[] = []): AutoRoutingQuotaSnapshot {
  const entries: AutoRoutingQuotaSnapshotEntry[] = PROVIDER_QUOTA_BINDINGS.map((binding) => {
    // Preserve the explicit presence of a provider-declared not-applicable
    // window even when the row itself is stale/non-ok: present-but-unusable
    // stays an explicit null constraint rather than disappearing into a
    // falsely complete row.
    const shape = quotaShapeOf(binding, findRow(rows, binding.providerId), nowMs);
    const requiredQuota = shape.targets.map((target) =>
      target.balanceId !== undefined
        ? { id: target.id, evidence: null, kind: 'balance' as const, balance: null }
        : { id: target.id, evidence: null },
    );
    return entryFields(binding, shape, requiredQuota);
  });
  return deepFreeze({
    snapshotId: randomUUID(),
    nowMs,
    validUntilMs: nowMs + UNKNOWN_SNAPSHOT_VALID_MS,
    entries,
    hardBlockedProviderIds: [],
  });
}

/**
 * Builds an immutable direct snapshot from the normalized report.
 *
 * Returns null when the report carries no fresh usable binding evidence and no
 * valid hard block; the caller then serves a short-lived unknown snapshot so a
 * successful-but-empty report is never cached as a 60s healthy success.
 */
function buildSnapshot(
  rows: readonly RawRow[],
  nowMs: number,
  allowCodeBuddyBlock: boolean,
): AutoRoutingQuotaSnapshot | null {
  const entries: AutoRoutingQuotaSnapshotEntry[] = [];
  const boundaries: number[] = [];
  let hasFreshBindingEvidence = false;

  for (const binding of PROVIDER_QUOTA_BINDINGS) {
    // Row lookup is by row.provider === binding.providerId (the owner
    // provider). Normalized pool ids are retained in output only.
    const row = findRow(rows, binding.providerId);
    const shape = quotaShapeOf(binding, row, nowMs);
    const usable = row !== null && rowUsable(row, nowMs);
    if (usable) {
      hasFreshBindingEvidence = true;
      boundaries.push((row.fetchedAtMs as number) + QUOTA_SNAPSHOT_VALID_FOR_MS);
    }
    const requiredQuota: RequiredQuotaConstraint[] = shape.targets.map((target) => {
      // A pool with no proven raw windows (no windowName) is always null, and
      // unrelated raw rows/windows never fabricate a constraint or evidence.
      // The row and the window/reset facts are narrowed together so an absent
      // value is never handed to evidence construction.
      if (target.balanceId !== undefined) {
        const balance = usable && row !== null ? balanceEvidence(row) : null;
        return { id: target.id, evidence: null, kind: 'balance', balance };
      }
      const evidence =
        usable && row !== null && target.windowName !== undefined
          ? windowEvidence(row, target.windowName, target.resetKind)
          : null;
      return { id: target.id, evidence };
    });
    entries.push(entryFields(binding, shape, requiredQuota));
  }

  // Privacy-safe observed CodeBuddy exhaustion is the only hard block produced
  // here. Go emits this neutral v2 retained negative row (exact `observed`
  // window, pct 100) WITHOUT fetched_at, so it is validated on
  // pool/status/stale/observed-window/pct100/future parsed resets_at alone;
  // the legacy monthly `1mo` window is inert. Invalid or expired observations
  // stay unknown (no block).
  const hardBlockedProviderIds: string[] = [];
  const codebuddyRow = allowCodeBuddyBlock
    ? rows.find((row) => codebuddyExhaustionReset(row) !== null) ?? null
    : null;
  const codebuddyResetAtMs = codebuddyRow === null ? null : codebuddyExhaustionReset(codebuddyRow);
  if (codebuddyResetAtMs !== null && codebuddyResetAtMs > nowMs) {
    hardBlockedProviderIds.push('codebuddy');
    // Retained negative rows bound the cache by the reset (capped below).
    boundaries.push(codebuddyResetAtMs);
  }

  if (!hasFreshBindingEvidence && hardBlockedProviderIds.length === 0) return null;

  const nowBoundary = nowMs + DIRECT_FRESHNESS_CAP_MS;
  const earliestBoundary = boundaries.length > 0 ? Math.min(...boundaries) : nowBoundary;
  const validUntilMs = Math.min(earliestBoundary, nowBoundary);
  if (validUntilMs <= nowMs) return null;

  return deepFreeze({
    snapshotId: randomUUID(),
    nowMs,
    validUntilMs,
    entries,
    hardBlockedProviderIds,
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value) as Array<keyof T>) {
    const child = value[key];
    if (child !== null && typeof child === 'object') deepFreeze(child);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Service: current-context cached, concurrent-fetch-deduplicated snapshot access
// ---------------------------------------------------------------------------

export class AutoRoutingQuotaSnapshotService {
  private readonly queryJson: (context?: CodeBuddyQueryContext) => Promise<string>;
  private readonly now: () => number;
  private readonly codeBuddySnapshot: (() => Promise<CodeBuddyActiveSnapshotView | undefined>) | undefined;
  /** Direct snapshots keyed by the private CodeBuddy query context. */
  private readonly cachedByContext = new Map<string, AutoRoutingQuotaSnapshot>();
  /** In-flight refreshes keyed by the same private CodeBuddy query context. */
  private readonly inFlightByContext = new Map<string, Promise<AutoRoutingQuotaSnapshot>>();

  constructor(options: AutoRoutingQuotaSnapshotServiceOptions = {}) {
    this.queryJson = options.queryJson ?? queryForgeQuotaJson;
    this.now = options.now ?? (() => Date.now());
    this.codeBuddySnapshot = options.codeBuddySnapshot;
  }

  /**
   * Returns the current immutable snapshot for the current CodeBuddy login.
   *
   * The optional CodeBuddy active snapshot is resolved afresh on every call
   * that has a loader. Only a non-empty opaque stable scope plus its
   * normalized environment forms the private query context; cached and
   * in-flight entries are keyed by that exact context, so a token refresh on
   * the same account reuses evidence while a login or environment change can
   * never reuse old cached/in-flight CodeBuddy state. Without a loader no
   * CodeBuddy context ever exists and the service behaves synchronously, as it
   * did before current-login scoping. A fresh cached snapshot is served until
   * its validUntilMs boundary; concurrent callers for the same context share
   * one in-flight query. A failed or empty refresh never serves expired old
   * evidence and returns a short-lived all-unknown snapshot instead.
   */
  async snapshot(): Promise<AutoRoutingQuotaSnapshot> {
    return (await this.routingSnapshot()).snapshot;
  }

  /**
   * Resolves one request-bound routing bundle. The active snapshot is loaded
   * exactly once, then the same immutable object is returned for readiness,
   * free-supply and canonical-to-wire evaluation while its scope/environment
   * select the quota cache/query. Callers must never serialize the bundle.
   */
  async routingSnapshot(): Promise<AutoRoutingBoundQuotaSnapshot> {
    // Keep the historical no-loader path synchronous through query start;
    // configured loaders remain one awaited auth read per routing request.
    const codeBuddySnapshot = this.codeBuddySnapshot === undefined
      ? undefined
      : await this.resolveCodeBuddySnapshot();
    const context = this.codeBuddyContext(codeBuddySnapshot);
    const key = codeBuddyContextKey(context);
    const nowMs = this.now();
    const cached = this.cachedByContext.get(key);
    if (cached !== undefined && cached.validUntilMs > nowMs) {
      return Object.freeze({ snapshot: cached, codeBuddySnapshot });
    }

    const pending = this.inFlightByContext.get(key);
    if (pending !== undefined) {
      return Object.freeze({ snapshot: await pending, codeBuddySnapshot });
    }

    const started = this.refresh(context).finally(() => {
      this.inFlightByContext.delete(key);
    });
    this.inFlightByContext.set(key, started);
    return Object.freeze({ snapshot: await started, codeBuddySnapshot });
  }

  /**
   * Resolves the current CodeBuddy query context afresh from the active
   * snapshot loader. Loader failures, missing/undefined snapshots, and absent
   * (empty) stable scopes all fail closed with no CodeBuddy context; the
   * normalized environment must also be non-empty to form a context.
   */
  private async resolveCodeBuddySnapshot(): Promise<CodeBuddyActiveSnapshotView | undefined> {
    if (this.codeBuddySnapshot === undefined) return undefined;
    try {
      return await this.codeBuddySnapshot();
    } catch {
      return undefined;
    }
  }

  private codeBuddyContext(view: CodeBuddyActiveSnapshotView | undefined): CodeBuddyQueryContext | undefined {
    if (view === undefined) return undefined;
    const stableScope = view.stableScope;
    const environment = view.environment;
    if (typeof stableScope !== 'string' || stableScope.length === 0) return undefined;
    if (typeof environment !== 'string' || environment.length === 0) return undefined;
    return { expectedScope: stableScope, expectedEnvironment: environment };
  }

  private async refresh(context: CodeBuddyQueryContext | undefined): Promise<AutoRoutingQuotaSnapshot> {
    let text: string;
    try {
      text = await this.queryJson(context);
    } catch {
      return this.failClosed(context);
    }
    // Evaluate provider observations against the time at which the asynchronous
    // sample completed. Forge stamps each provider row as that provider
    // finishes, so sampling `now` before the query would incorrectly classify
    // ordinary rows produced during a slow refresh as future evidence. This
    // still rejects genuine clock-skewed future timestamps in rowUsable().
    const nowMs = this.now();
    try {
      const rows = parseQuotaReport(text);
      // Defense in depth: even an injected/misbehaving query source cannot
      // activate a CodeBuddy negative row without a complete current scope.
      const snapshot = buildSnapshot(rows, nowMs, context !== undefined);
      if (snapshot === null) return this.failClosed(context, rows);
      this.cachedByContext.set(codeBuddyContextKey(context), snapshot);
      return snapshot;
    } catch {
      return this.failClosed(context);
    }
  }

  private failClosed(
    context: CodeBuddyQueryContext | undefined,
    rows: readonly RawRow[] = [],
  ): AutoRoutingQuotaSnapshot {
    // Never serve expired old evidence after a failed or empty refresh for the
    // current context; drop only that context's cache and hand back a
    // short-lived unknown snapshot. Other contexts (e.g. a previous login) can
    // never be served because they are keyed separately.
    this.cachedByContext.delete(codeBuddyContextKey(context));
    return buildUnknownSnapshot(this.now(), rows);
  }
}
