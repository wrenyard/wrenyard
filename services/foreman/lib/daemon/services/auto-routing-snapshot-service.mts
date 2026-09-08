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
 * numeric id or epoch timestamp fields, and nothing here invents them.
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
 *  - a binding row is located by `binding.quotaProviderId` (the raw pool,
 *    e.g. cursor/kimi-coding/zhipu-coding) while the normalized
 *    `binding.quotaPoolId` is retained in output only; a window is located by
 *    exact `name`;
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
 * CodeBuddy exhaustion signal: exact pool `codebuddy`, ok/non-stale row, exact
 * `1mo` window name, raw used pct exactly 100 and a finite future parsed
 * `resets_at`. Go intentionally emits this retained negative row WITHOUT
 * `fetched_at`, so it is validated without one; its cache is bounded by
 * min(now + 60s, reset). Absence, invalid or expired observations stay unknown
 * (never a block).
 *
 * Out of scope by construction: prices, tariffs, credits, fallback routing and
 * credentials. No network logic lives in TypeScript; the default query spawns
 * the existing Foreman Forge helper (no shell, bounded timeout, capped
 * stdout/stderr) to run exactly `forge quota --json`. Output that exceeds the
 * caps terminates the child and is rejected, never parsed as truncated data.
 */

import { randomUUID } from 'node:crypto';

import { queryForgeQuotaJson } from '../execution/forge-quota-query.mts';

import type { QuotaEvidence, RequiredQuotaConstraint, ReplenishmentKind } from '@wrenyard/catalog';
import { PROVIDER_QUOTA_BINDINGS } from '@wrenyard/providers';

/** Evidence freshness window for a direct raw observation (ms). */
const QUOTA_SNAPSHOT_VALID_FOR_MS = 60_000;

/** A snapshot may never claim direct freshness further than now + this cap. */
const DIRECT_FRESHNESS_CAP_MS = 60_000;

/** Validity of a fail-closed unknown snapshot (short-lived, never cached). */
const UNKNOWN_SNAPSHOT_VALID_MS = 15_000;

// ---------------------------------------------------------------------------
// Public snapshot shape
// ---------------------------------------------------------------------------

/** One binding entry in a snapshot with its frozen required quota constraints. */
export interface AutoRoutingQuotaSnapshotEntry {
  readonly providerId: string;
  readonly modelId: string;
  /** Normalized single-pool id; retained only for legacy single-pool bindings. */
  readonly quotaPoolId?: string;
  /** Every jointly required normalized pool id (multi-pool bindings only). */
  readonly quotaPoolIds?: readonly string[];
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
 */
export interface AutoRoutingQuotaSnapshot {
  readonly snapshotId: string;
  readonly nowMs: number;
  readonly validUntilMs: number;
  readonly entries: readonly AutoRoutingQuotaSnapshotEntry[];
  readonly hardBlockedProviderIds: readonly string[];
}

export interface AutoRoutingQuotaSnapshotServiceOptions {
  /** Query source for the raw `forge quota --json` text (defaults to the daemon spawn). */
  queryJson?: () => Promise<string>;
  /** Current time in epoch ms (defaults to Date.now). */
  now?: () => number;
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

interface RawRow {
  readonly pool: string | null;
  readonly status: string | null;
  readonly stale: boolean;
  readonly fetchedAtMs: number | null;
  readonly windows: readonly RawWindow[];
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

  return {
    pool: stringOrNull(raw.pool),
    status: stringOrNull(raw.status),
    stale: raw.stale === true,
    fetchedAtMs: isoTimeMs(raw.fetched_at),
    windows: Object.freeze(windows),
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
    row.pool !== null &&
    row.status === 'ok' &&
    row.stale === false &&
    row.fetchedAtMs !== null &&
    row.fetchedAtMs <= nowMs &&
    row.fetchedAtMs + QUOTA_SNAPSHOT_VALID_FOR_MS > nowMs
  );
}

function findRow(rows: readonly RawRow[], poolId: string): RawRow | null {
  return rows.find((row) => row.pool === poolId) ?? null;
}

/**
 * One required-quota target derived from a binding's applicability metadata.
 *
 * Window-less markers (jointly required pools with no proven raw windows)
 * carry only the normalized pool id: no windowName and no reset facts, so
 * their evidence stays null (unknown coverage) and an absent window/reset
 * value can never reach evidence construction.
 */
type RequiredQuotaTarget =
  | {
      readonly id: string;
      readonly windowName?: undefined;
      readonly resetKind?: undefined;
    }
  | {
      readonly id: string;
      /** Exact raw window name on the provider row; present only when the pool
       *  has proven raw windows located by exact name. */
      readonly windowName: string;
      /** Replenishment semantics come exclusively from the binding window
       *  constraint; never invented from raw output. */
      readonly resetKind: unknown;
    };

interface BindingQuotaShape {
  readonly quotaPoolId?: string;
  readonly quotaPoolIds?: string[];
  readonly targets: readonly RequiredQuotaTarget[];
}

/**
 * Expands a ProviderQuotaBinding into its required constraint targets.
 *
 * A legacy single-pool binding contributes one target per declared raw window.
 * A multi-pool binding contributes every jointly required pool: each pool that
 * carries proven raw windows contributes one target per window located by
 * exact name; a pool with no proven raw windows contributes exactly one
 * constraint keyed by the normalized pool id whose evidence stays null so the
 * pool coverage remains incomplete/unknown.
 */
function quotaShapeOf(binding: {
  readonly quotaPoolId?: string;
  readonly windows?: readonly { readonly windowId: string; readonly resetKind: unknown }[];
  readonly pools?: readonly {
    readonly quotaPoolId: string;
    readonly windows: readonly { readonly windowId: string; readonly resetKind: unknown }[];
  }[];
}): BindingQuotaShape {
  const pools = binding.pools ?? [];
  if (pools.length > 0) {
    const quotaPoolIds: string[] = [];
    const targets: RequiredQuotaTarget[] = [];
    for (const pool of pools) {
      quotaPoolIds.push(pool.quotaPoolId);
      if (pool.windows.length === 0) {
        // No raw provider window evidence has been reviewed for this pool yet:
        // one required null constraint keyed by the normalized pool id keeps
        // coverage incomplete/unknown. Nothing here invents raw rows or windows.
        targets.push({ id: pool.quotaPoolId });
        continue;
      }
      for (const window of pool.windows) {
        targets.push({ id: window.windowId, windowName: window.windowId, resetKind: window.resetKind });
      }
    }
    return { quotaPoolIds, targets };
  }
  return {
    quotaPoolId: binding.quotaPoolId,
    targets: (binding.windows ?? []).map((window) => ({
      id: window.windowId,
      windowName: window.windowId,
      resetKind: window.resetKind,
    })),
  };
}

/** Builds the immutable entry fields for a binding from its required quota. */
function entryFields(
  binding: { readonly providerId: string; readonly modelId: string },
  shape: BindingQuotaShape,
  requiredQuota: RequiredQuotaConstraint[],
): AutoRoutingQuotaSnapshotEntry {
  const base = { providerId: binding.providerId, modelId: binding.modelId, requiredQuota };
  return shape.quotaPoolIds !== undefined
    ? { ...base, quotaPoolIds: shape.quotaPoolIds }
    : { ...base, quotaPoolId: shape.quotaPoolId as string };
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

/** The CodeBuddy retained negative reset time, or null when it is invalid. */
function codebuddyExhaustionReset(row: RawRow): number | null {
  if (row.pool !== 'codebuddy') return null;
  if (row.status !== 'ok') return null;
  if (row.stale !== false) return null;
  const oneMonth = row.windows.find((window) => window.name === '1mo');
  if (oneMonth === undefined) return null;
  if (oneMonth.pct !== 100) return null;
  return oneMonth.resetsAtMs; // Validated as finite-future by the caller.
}

function buildUnknownSnapshot(nowMs: number): AutoRoutingQuotaSnapshot {
  const entries: AutoRoutingQuotaSnapshotEntry[] = PROVIDER_QUOTA_BINDINGS.map((binding) => {
    const shape = quotaShapeOf(binding);
    const requiredQuota = shape.targets.map((target) => ({
      id: target.id,
      evidence: null,
    }));
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
function buildSnapshot(rows: readonly RawRow[], nowMs: number): AutoRoutingQuotaSnapshot | null {
  const entries: AutoRoutingQuotaSnapshotEntry[] = [];
  const boundaries: number[] = [];
  let hasFreshBindingEvidence = false;

  for (const binding of PROVIDER_QUOTA_BINDINGS) {
    const shape = quotaShapeOf(binding);
    // Row lookup is by binding.quotaProviderId (the raw pool name). The
    // normalized pool ids are retained in output only.
    const row = findRow(rows, binding.quotaProviderId);
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
      const evidence =
        usable && row !== null && target.windowName !== undefined
          ? windowEvidence(row, target.windowName, target.resetKind)
          : null;
      return { id: target.id, evidence };
    });
    entries.push(entryFields(binding, shape, requiredQuota));
  }

  // Privacy-safe observed CodeBuddy exhaustion is the only hard block produced
  // here. Go emits this retained negative row WITHOUT fetched_at, so it is
  // validated on pool/status/stale/1mo/pct100/future parsed resets_at alone.
  // Invalid or expired observations stay unknown (no block).
  const hardBlockedProviderIds: string[] = [];
  const codebuddyRow = findRow(rows, 'codebuddy');
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
// Service: cached, concurrent-fetch-deduplicated snapshot access
// ---------------------------------------------------------------------------

export class AutoRoutingQuotaSnapshotService {
  private readonly queryJson: () => Promise<string>;
  private readonly now: () => number;
  private cached: AutoRoutingQuotaSnapshot | null = null;
  private inFlight: Promise<AutoRoutingQuotaSnapshot> | null = null;

  constructor(options: AutoRoutingQuotaSnapshotServiceOptions = {}) {
    this.queryJson = options.queryJson ?? queryForgeQuotaJson;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Returns the current immutable snapshot. A fresh cached snapshot is served
   * until its validUntilMs boundary. Concurrent callers share one in-flight
   * query. A failed or empty refresh never serves expired old evidence and
   * returns a short-lived all-unknown snapshot instead.
   */
  snapshot(): Promise<AutoRoutingQuotaSnapshot> {
    const nowMs = this.now();
    const cached = this.cached;
    if (cached !== null && cached.validUntilMs > nowMs) return Promise.resolve(cached);

    const pending = this.inFlight;
    if (pending !== null) return pending;

    const started = this.refresh().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = started;
    return started;
  }

  private async refresh(): Promise<AutoRoutingQuotaSnapshot> {
    const nowMs = this.now();
    let text: string;
    try {
      text = await this.queryJson();
    } catch {
      return this.failClosed(nowMs);
    }
    try {
      const rows = parseQuotaReport(text);
      const snapshot = buildSnapshot(rows, nowMs);
      if (snapshot === null) return this.failClosed(nowMs);
      this.cached = snapshot;
      return snapshot;
    } catch {
      return this.failClosed(nowMs);
    }
  }

  private failClosed(nowMs: number): AutoRoutingQuotaSnapshot {
    // Never serve expired old evidence after a failed or empty refresh; drop
    // the cache and hand back a short-lived unknown snapshot.
    this.cached = null;
    return buildUnknownSnapshot(nowMs);
  }
}
