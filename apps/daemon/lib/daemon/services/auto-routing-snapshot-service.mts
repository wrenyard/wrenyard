/**
 * Daemon-owned immutable quota snapshot service for automatic routing.
 *
 * This service is the single runtime place that turns serialized quota-service
 * output into policy-shaped quota evidence for auto-routing. It deliberately
 * does NOT own any provider/model/pool/applicability mapping: binding
 * metadata is imported as PROVIDER_QUOTA_BINDINGS (@wrenyard/providers) and the
 * policy constraints/evidence shapes come from @wrenyard/auto-routing, so there is
 * exactly one canonical binding table and no duplicated policy types.
 *
 * Raw parsing is fail-closed against the compatible quota-service list DTO
 * emitted by @wrenyard/quota: each pool entry carries
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
 * credentials. Provider acquisition is coordinated by @wrenyard/quota; the default query uses
 * the existing Foreman Wrenyard helper (no shell, bounded timeout, capped
 * stdout/stderr) for raw account data and client-protocol requests. Output that exceeds the
 * caps terminates the child and is rejected, never parsed as truncated data.
 */

import { randomUUID } from 'node:crypto';

import { queryQuotaJson, type CodeBuddyQueryContext } from '../execution/quota-query.mts';

import { assessRequiredQuota } from '@wrenyard/auto-routing';
import type { BalanceEvidence, QuotaEvidence, QuotaEvidenceStatus, RequiredQuotaConstraint, ReplenishmentKind } from '@wrenyard/auto-routing';
import type {
  AutoRoutingBoundQuotaSnapshot as PackageAutoRoutingBoundQuotaSnapshot,
  AutoRoutingQuotaSnapshot,
  AutoRoutingQuotaSnapshotEntry,
} from '@wrenyard/auto-routing';
import { PROVIDER_QUOTA_BINDINGS } from '@wrenyard/providers';
import { CHATGPT_CREDITS_POOL, selectChatGptFundingSource, type ChatGptCreditsAvailability } from '@wrenyard/providers/chatgpt';
import { codeBuddyPoolsForModel } from '@wrenyard/providers/codebuddy';
import { WORKBUDDY_PROVIDER_IDS, workBuddyPoolsForModel } from '@wrenyard/providers/workbuddy';
import type { WorkBuddyAccountKind } from '@wrenyard/providers/workbuddy';
import type { ProviderQuotaBinding, ProviderQuotaPool } from '@wrenyard/providers';
import { QUOTA_EVIDENCE_GRACE_MS } from '@wrenyard/auto-routing';
/** Evidence freshness window for a direct raw observation (ms). */
const QUOTA_SNAPSHOT_VALID_FOR_MS = 60_000;

/**
 * Freshness stamped on a retained last-measured observation reused after a
 * failed/stale read. It spans the whole grace period so the policy can apply
 * the last measured state for 30 minutes and then fall back to insufficient.
 */
const RETAINED_EVIDENCE_VALID_FOR_MS = QUOTA_EVIDENCE_GRACE_MS;

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

/**
 * Deterministic private cache key for one query context: the CodeBuddy
 * scope/environment plus every observed WorkBuddy login type, so evidence of a
 * previous login type is never served after an account switch.
 */
function codeBuddyContextKey(
  context: CodeBuddyQueryContext | undefined,
  workBuddyKinds: Readonly<Record<string, string>> = {},
): string {
  if (context === undefined && Object.keys(workBuddyKinds).length === 0) return NO_CODEBUDDY_CONTEXT_KEY;
  return `${context?.expectedScope}\u0000${context?.expectedEnvironment}\u0000${JSON.stringify(workBuddyKinds)}`;
}

// ---------------------------------------------------------------------------
// Public snapshot shape
// ---------------------------------------------------------------------------

export type { AutoRoutingQuotaSnapshotEntry, AutoRoutingQuotaSnapshot };

/**
 * Private daemon routing bundle. The quota DTO remains serialization-safe;
 * the optional active CodeBuddy snapshot is retained only in-process so one
 * auth read can drive scope, environment, wire mapping and free eligibility.
 * `codeBuddySnapshot` is the concrete in-process view, assignable to the
 * routing package's opaque `unknown`.
 */
export interface AutoRoutingBoundQuotaSnapshot extends PackageAutoRoutingBoundQuotaSnapshot {
  readonly codeBuddySnapshot: CodeBuddyActiveSnapshotView | undefined;
}

/**
 * The structural surface consumers need: the immutable routing snapshot plus
 * evidence invalidation. Declared as an interface (not the concrete class) so
 * the daemon can wrap the service — e.g. to publish each snapshot's effective
 * pool set to gateway admission — without a second quota source.
 */
export interface AutoRoutingQuotaSnapshotSource {
  snapshot(): Promise<AutoRoutingQuotaSnapshot>;
  routingSnapshot(): Promise<AutoRoutingBoundQuotaSnapshot>;
  invalidateProviderEvidence(providerId: string): void;
}

export interface AutoRoutingQuotaSnapshotServiceOptions {
  /** Query source for the serialized quota-service text (defaults to the daemon
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
  /** Live gateway pool exhaustion observations keyed `${providerId}|${quotaPoolId}`. */
  observedPoolExhaustion?: () => ReadonlyMap<string, number>;
  /**
   * Daemon-owned reader of each WorkBuddy provider's current login type, keyed
   * by provider id. WorkBuddy entries are rebound to the pool set of that
   * login type (iOA draws the usage-unknown credits pool), and the cache key
   * carries it so evidence of the previous login type is never reused.
   */
  workBuddyAccountKinds?: () => Readonly<Record<string, string>>;
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

/** One raw Wrenyard balance entry: a monetary `{ currency, amount }` row or a
 * unit-denominated `{ id, unit, amount|null, unlimited?, availability? }` row. */
interface RawBalance {
  readonly id: string | null;
  readonly currency: string | null;
  readonly amount: string | null;
  readonly unit: string | null;
  readonly unlimited: boolean;
  /** Parser-attested flag-derived availability (ChatGPT Credits only). */
  readonly availability: ChatGptCreditsAvailability | null;
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

  // Existing Wrenyard balances source: raw `balances` rows, either monetary
  // `{ currency, amount }` or unit-denominated `{ id, unit, amount|null,
  // unlimited? }`. Never synthesized, never coerced to zero.
  const balances: RawBalance[] = [];
  if (Array.isArray(raw.balances)) {
    for (const entry of raw.balances) {
      if (entry === null || typeof entry !== 'object') {
        balances.push({ id: null, currency: null, amount: null, unit: null, unlimited: false, availability: null });
        continue;
      }
      const balance = entry as Record<string, unknown>;
      const rawAvailability = balance.availability;
      balances.push({
        id: stringOrNull(balance.id),
        currency: stringOrNull(balance.currency),
        amount: stringOrNull(balance.amount),
        unit: stringOrNull(balance.unit),
        unlimited: balance.unlimited === true,
        availability: rawAvailability === 'available' || rawAvailability === 'unavailable' || rawAvailability === 'unknown'
          ? rawAvailability : null,
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
      /** Copied from the pool declaration: usage is never exposed here. */
      readonly usageUnknown?: boolean;
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
      /** Copied from the pool declaration: usage is never exposed here. */
      readonly usageUnknown?: boolean;
    }
  | {
      /** Mandatory monetary balance resource; evidence is located by the raw
       *  Wrenyard balances array on the same provider row. */
      readonly id: string;
      readonly balanceId: string;
      readonly windowName?: undefined;
      readonly resetKind?: undefined;
      /** Copied from the pool declaration: usage is never exposed here. */
      readonly usageUnknown?: boolean;
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
 *    evidence sourced from the same raw row's Wrenyard `balances` array;
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
    readonly usageUnknown?: boolean;
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
    // A pool whose provider never exposes usage keeps that declaration, so the
    // policy classifies it as unknown by design instead of a failed read.
    const usageUnknown = pool.usageUnknown === true ? { usageUnknown: true } : {};
    if (pool.kind === 'balance') {
      targets.push({ id: pool.quotaPoolId, balanceId: pool.quotaPoolId, ...usageUnknown });
    } else if (window) {
      targets.push({ id: pool.quotaPoolId, windowName: window.windowId, resetKind: window.resetKind, ...usageUnknown });
    } else {
      targets.push({ id: pool.quotaPoolId, ...usageUnknown });
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

function windowEvidence(
  row: RawRow,
  windowName: string,
  resetKind: unknown,
  validForMs = QUOTA_SNAPSHOT_VALID_FOR_MS,
): QuotaEvidence | null {
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
    return { remainingPercent, observedAtMs, validForMs, replenishmentKind };
  }
  if (replenishmentKind === 'full_cycle') {
    // Full-cycle evidence carries the parsed reset time and cycle duration.
    if (rawWindow.resetsAtMs === null || rawWindow.windowMs === null) return null;
    return {
      remainingPercent,
      observedAtMs,
      validForMs,
      replenishmentKind,
      resetAtMs: rawWindow.resetsAtMs,
      windowMs: rawWindow.windowMs,
    };
  }
  // rolling_partial/unknown carry no reset pace.
  return { remainingPercent, observedAtMs, validForMs, replenishmentKind };
}

/**
 * The most recent row of one provider that was usable when it was read, kept
 * only while it is inside the last-measured grace period. A failed, refused or
 * stale read reuses it so the route keeps its last measured state for 30
 * minutes; afterwards the read is reported as not obtained and the policy maps
 * that to insufficient.
 */
function retainedRow(
  lastUsableRows: ReadonlyMap<string, RawRow>,
  providerId: string,
  nowMs: number,
): RawRow | null {
  const row = lastUsableRows.get(providerId);
  if (row === undefined || row.fetchedAtMs === null) return null;
  if (row.fetchedAtMs > nowMs) return null;
  return nowMs - row.fetchedAtMs <= QUOTA_EVIDENCE_GRACE_MS ? row : null;
}

function constraintOf(
  target: RequiredQuotaTarget,
  evidence: QuotaEvidence | null,
  balance: BalanceEvidence | null,
  evidenceStatus: QuotaEvidenceStatus,
): RequiredQuotaConstraint {
  const usageUnknown = target.usageUnknown === true ? { usageUnknown: true } : {};
  if (target.balanceId !== undefined) {
    return { id: target.id, evidence: null, kind: 'balance', balance, evidenceStatus, ...usageUnknown };
  }
  return { id: target.id, evidence, evidenceStatus, ...usageUnknown };
}

function poolExhaustionKey(providerId: string, target: RequiredQuotaTarget): string {
  const poolId = target.balanceId ?? target.id;
  return `${providerId}|${poolId}`;
}

function applyObservedPoolExhaustion(
  providerId: string,
  target: RequiredQuotaTarget,
  constraint: RequiredQuotaConstraint,
  observedPoolExhaustion: ReadonlyMap<string, number> | undefined,
): RequiredQuotaConstraint {
  if (observedPoolExhaustion === undefined || !observedPoolExhaustion.has(poolExhaustionKey(providerId, target))) {
    return constraint;
  }
  return { ...constraint, observedExhausted: true };
}

/**
 * Builds discriminated monetary balance evidence for one mandatory balance
 * resource from the raw Wrenyard balances array on the same row.
 *
 * Only a usable row with a fresh observation yields evidence: any valid positive
 * balance keeps the account available (all must be valid to claim all-zero).
 * Nothing here synthesizes a percentage, reset period, free-supply fact, FX rate
 * or guaranteed affordability from money; malformed/absent amounts surface as
 * the raw string (or null) so the policy treats them as unknown, never zero.
 */
function balanceEvidence(row: RawRow, validForMs = QUOTA_SNAPSHOT_VALID_FOR_MS): BalanceEvidence | null {
  if (row.fetchedAtMs === null || row.balances.length === 0) return null;
  let positive: string | undefined;
  let positiveCurrency: string | null = null;
  let allValid = true;
  for (const entry of row.balances) {
    if (entry.currency === null || !/^[A-Z]{3}$/.test(entry.currency) || entry.amount === null || !/^\d+(?:\.\d+)?$/.test(entry.amount)) {
      allValid = false;
      continue;
    }
    // The currency of the reported amount selects the low-balance threshold.
    if (positive === undefined && /[1-9]/.test(entry.amount)) {
      positive = entry.amount;
      positiveCurrency = entry.currency;
    }
  }
  // Currencies are alternative balances, not amounts to add or convert.
  // One valid positive suffices; claim zero only when every entry is valid.
  if (positive === undefined && !allValid) return null;
  return {
    amount: positive ?? '0',
    currency: positiveCurrency,
    observedAtMs: row.fetchedAtMs,
    validForMs,
  };
}

/**
 * Evidence for one explicitly identified unit-denominated balance (e.g.
 * `chatgpt/credits`), matched by stable `id` — never by the monetary
 * first-positive heuristic, so an unrelated balance row can never fund it.
 * Availability comes from the parser's `availability` classification (derived
 * from the upstream `unlimited`/`hasCredits` flags), never from the numeric
 * amount. A present amount is carried verbatim for Credits state bands after
 * the availability gate permits it.
 */
function unitBalanceEvidence(
  row: RawRow,
  balanceId: string,
  validForMs = QUOTA_SNAPSHOT_VALID_FOR_MS,
): BalanceEvidence | null {
  if (row.fetchedAtMs === null) return null;
  const entry = row.balances.find((balance) => balance.id === balanceId && balance.unit !== null);
  if (entry === undefined) return null;
  const amount = entry.amount !== null && /^[+-]?\d+(?:\.\d+)?$/.test(entry.amount)
    ? entry.amount : undefined;
  if (entry.availability === 'available') {
    return {
      availability: 'available',
      unlimited: entry.unlimited || undefined,
      unit: entry.unit ?? undefined,
      amount,
      observedAtMs: row.fetchedAtMs,
      validForMs,
    };
  }
  if (entry.availability === 'unavailable') {
    return {
      availability: 'unavailable',
      unit: entry.unit ?? undefined,
      amount,
      observedAtMs: row.fetchedAtMs,
      validForMs,
    };
  }
  // Unknown — including a legacy Credits row emitted before the availability
  // field existed — is an explicit parser-attested classification, so the
  // policy never falls through to amount/unlimited inference.
  const unknownAvailability: 'unknown' | undefined =
    entry.availability === 'unknown' || entry.unit === 'Credits' ? 'unknown' : undefined;
  return {
    ...(unknownAvailability === undefined ? {} : { availability: unknownAvailability }),
    unit: entry.unit ?? undefined,
    amount,
    observedAtMs: row.fetchedAtMs,
    validForMs,
  };
}

/**
 * The ChatGPT Credits constraint for one row, or null when the row cannot
 * prove the balance exists (no usable observation / no matching row id).
 * `evidenceStatus` follows the row: measured only on a fresh usable row.
 */
function chatGptCreditsConstraint(
  source: RawRow | null,
  usable: boolean,
  providerId: string,
  observedPoolExhaustion: ReadonlyMap<string, number> | undefined,
): RequiredQuotaConstraint {
  const target: RequiredQuotaTarget = { id: CHATGPT_CREDITS_POOL.quotaPoolId, balanceId: CHATGPT_CREDITS_POOL.quotaPoolId };
  const balance = source === null
    ? null
    : unitBalanceEvidence(source, CHATGPT_CREDITS_POOL.quotaPoolId,
      usable ? QUOTA_SNAPSHOT_VALID_FOR_MS : RETAINED_EVIDENCE_VALID_FOR_MS);
  const constraint = constraintOf(target, null, balance, usable && balance !== null ? 'measured' : 'not_obtained');
  return applyObservedPoolExhaustion(providerId, target, constraint, observedPoolExhaustion);
}

/**
 * One measured state classification for the Credits constraint: availability
 * comes from the parser's flag-derived `availability` field, never from the
 * numeric amount alone. The shared policy supplies state and freshness validation.
 */
function chatGptCreditsState(nowMs: number, constraint: RequiredQuotaConstraint): 'available' | 'empty' | 'unknown' {
  const assessment = assessRequiredQuota(nowMs, [constraint]);
  if (assessment.state === 'exhausted') return 'empty';
  if (constraint.balance?.availability === 'available' && assessment.state === 'insufficient'
    && assessment.evidence === 'measured'
    && assessment.constraints.every((item) => item.rejectCode === null)) return 'available';
  return 'unknown';
}

/**
 * Applies the shared ChatGPT subscription-first rule to one binding's
 * constraint set. Applicable subscription pools are conjunctive; a confirmed
 * exhaustion in any of them hands eligibility to the Credits balance pool.
 * The effective set is what `requiredQuota`, `quotaPoolIds`, the routing
 * price factor and gateway admission all consume:

 * - `subscription`: unchanged subscription constraints (the declared AND set);
 * - `credits`: only the Credits balance constraint;
 * - `exhausted`: subscription constraints kept — the route reports the
 *   confirmed exhaustion;
 * - `unresolved`: only the Credits constraint — unknown Credits yields
 *   insufficient, never a fabricated zero or a mislabeled paid state.
 */
function applyChatGptFundingSource(
  nowMs: number,
  quotaPoolIds: string[],
  requiredQuota: RequiredQuotaConstraint[],
  creditsConstraint: RequiredQuotaConstraint,
): { quotaPoolIds: string[]; requiredQuota: RequiredQuotaConstraint[] } {
  const assessment = assessRequiredQuota(nowMs, requiredQuota);
  const subscriptionExhausted = assessment.constraints.some((constraint) => constraint.state === 'exhausted');
  const source = selectChatGptFundingSource({
    subscriptionExhausted,
    credits: chatGptCreditsState(nowMs, creditsConstraint),
  });
  switch (source) {
    case 'credits':
      return { quotaPoolIds: [CHATGPT_CREDITS_POOL.quotaPoolId], requiredQuota: [creditsConstraint] };
    case 'unresolved':
      // Unknown is represented by the unresolved source itself — never
      // mislabeled as paid eligibility or fabricated as zero.
      return { quotaPoolIds: [CHATGPT_CREDITS_POOL.quotaPoolId], requiredQuota: [creditsConstraint] };
    default:
      return { quotaPoolIds, requiredQuota };
  }
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

/**
 * Resolves the bindings the routing snapshot builds constraints from.
 *
 * PROVIDER_QUOTA_BINDINGS is the static catalog table: its CodeBuddy pools are
 * the non-iOA declarations. When the live CodeBuddy login reports an
 * environment, the CodeBuddy entries are rebound through
 * codeBuddyPoolsForModel so iOA's pay-as-you-go monthly pool (usageUnknown)
 * reaches the constraints; HY family and non-CodeBuddy providers keep the
 * static declarations. An absent environment falls back to the static table.
 *
 * WorkBuddy entries are rebound the same way by the live login type through
 * workBuddyPoolsForModel: an iOA WorkBuddy login draws the usage-unknown
 * credits pool (pay-as-you-go), every other login type keeps the measured
 * credits pool. A provider with no observed login type keeps the static table.
 */
function routingBindings(
  environment: string | undefined,
  workBuddyKinds: Readonly<Record<string, string>> = {},
): readonly ProviderQuotaBinding[] {
  if (environment === undefined && Object.keys(workBuddyKinds).length === 0) return PROVIDER_QUOTA_BINDINGS;
  return PROVIDER_QUOTA_BINDINGS.map((binding) => {
    if (binding.providerId === 'codebuddy' && environment !== undefined) {
      return { ...binding, pools: codeBuddyPoolsForModel(binding.modelId, environment) as readonly ProviderQuotaPool[] };
    }
    const kind = workBuddyKinds[binding.providerId];
    if (kind !== undefined && WORKBUDDY_PROVIDER_IDS.includes(binding.providerId)) {
      return { ...binding, pools: workBuddyPoolsForModel(binding.providerId, binding.modelId, kind as WorkBuddyAccountKind) as readonly ProviderQuotaPool[] };
    }
    return binding;
  });
}

function buildUnknownSnapshot(
  nowMs: number,
  rows: readonly RawRow[] = [],
  lastUsableRows: ReadonlyMap<string, RawRow> = new Map(),
  environment?: string,
  workBuddyKinds: Readonly<Record<string, string>> = {},
): AutoRoutingQuotaSnapshot {
  const entries: AutoRoutingQuotaSnapshotEntry[] = routingBindings(environment, workBuddyKinds).map((binding) => {
    // Preserve the explicit presence of a provider-declared not-applicable
    // window even when the row itself is stale/non-ok: present-but-unusable
    // stays an explicit null constraint rather than disappearing into a
    // falsely complete row.
    const shape = quotaShapeOf(binding, findRow(rows, binding.providerId), nowMs);
    // A failed or empty refresh reuses the last usable row inside the grace
    // period as not-obtained evidence; afterwards the constraint carries no
    // numbers at all and the policy reports insufficient.
    const retained = retainedRow(lastUsableRows, binding.providerId, nowMs);
    const requiredQuota = shape.targets.map((target) =>
      target.balanceId !== undefined
        ? constraintOf(target, null, retained === null ? null
          : (unitBalanceEvidence(retained, target.balanceId, RETAINED_EVIDENCE_VALID_FOR_MS)
            ?? balanceEvidence(retained, RETAINED_EVIDENCE_VALID_FOR_MS)), 'not_obtained')
        : constraintOf(target, retained === null || target.windowName === undefined
          ? null
          : windowEvidence(retained, target.windowName, target.resetKind, RETAINED_EVIDENCE_VALID_FOR_MS), null, 'not_obtained'),
    );
    if (binding.providerId === 'chatgpt') {
      const credits = chatGptCreditsConstraint(retained, false, binding.providerId, undefined);
      const effective = applyChatGptFundingSource(nowMs, shape.quotaPoolIds, requiredQuota, credits);
      return entryFields(binding, { ...shape, quotaPoolIds: effective.quotaPoolIds }, effective.requiredQuota);
    }
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
  lastUsableRows: Map<string, RawRow>,
  observedPoolExhaustion: ReadonlyMap<string, number> | undefined,
  environment?: string,
  workBuddyKinds: Readonly<Record<string, string>> = {},
): AutoRoutingQuotaSnapshot | null {
  const entries: AutoRoutingQuotaSnapshotEntry[] = [];
  const boundaries: number[] = [];
  let hasFreshBindingEvidence = false;

  for (const binding of routingBindings(environment, workBuddyKinds)) {
    // Row lookup is by row.provider === binding.providerId (the owner
    // provider). Normalized pool ids are retained in output only.
    const row = findRow(rows, binding.providerId);
    const shape = quotaShapeOf(binding, row, nowMs);
    const usable = row !== null && rowUsable(row, nowMs);
    if (usable) {
      hasFreshBindingEvidence = true;
      boundaries.push((row.fetchedAtMs as number) + QUOTA_SNAPSHOT_VALID_FOR_MS);
      // Retain the newest usable row so a later failed/stale read can reuse its
      // measurement for the grace period.
      lastUsableRows.set(binding.providerId, row);
    }
    // A row that is missing, non-ok, stale or unfresh is a failed read: reuse
    // the retained row inside the grace period as not-obtained evidence.
    const retained = usable ? null : retainedRow(lastUsableRows, binding.providerId, nowMs);
    const source = usable ? row : retained;
    const requiredQuota: RequiredQuotaConstraint[] = shape.targets.map((target) => {
      // A pool with no proven raw windows (no windowName) is always null, and
      // unrelated raw rows/windows never fabricate a constraint or evidence.
      // The row and the window/reset facts are narrowed together so an absent
      // value is never handed to evidence construction.
      let constraint: RequiredQuotaConstraint;
      if (target.balanceId !== undefined) {
        const validFor = usable ? QUOTA_SNAPSHOT_VALID_FOR_MS : RETAINED_EVIDENCE_VALID_FOR_MS;
        const balance = source === null
          ? null
          : (unitBalanceEvidence(source, target.balanceId, validFor) ?? balanceEvidence(source, validFor));
        constraint = constraintOf(target, null, balance, usable && balance !== null ? 'measured' : 'not_obtained');
      } else {
        const evidence = source !== null && target.windowName !== undefined
          ? windowEvidence(source, target.windowName, target.resetKind,
            usable ? QUOTA_SNAPSHOT_VALID_FOR_MS : RETAINED_EVIDENCE_VALID_FOR_MS)
          : null;
        constraint = constraintOf(target, evidence, null, usable && evidence !== null ? 'measured' : 'not_obtained');
      }
      return applyObservedPoolExhaustion(binding.providerId, target, constraint, observedPoolExhaustion);
    });
    if (binding.providerId === 'chatgpt') {
      const credits = chatGptCreditsConstraint(source, usable, binding.providerId, observedPoolExhaustion);
      const effective = applyChatGptFundingSource(nowMs, shape.quotaPoolIds, requiredQuota, credits);
      entries.push(entryFields(binding, { ...shape, quotaPoolIds: effective.quotaPoolIds }, effective.requiredQuota));
      continue;
    }
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
  /**
   * Newest row of each provider that was usable when read, retained in memory
   * only. A later failed/stale/unfresh read reuses it as not-obtained evidence
   * for the last-measured grace period; it never leaves the process.
   */
  private readonly lastUsableRows = new Map<string, RawRow>();
  /**
   * Monotonic evidence epoch, bumped by {@link invalidateProviderEvidence}.
   * A refresh that started before an invalidation compares its captured epoch
   * after the async query and discards everything it measured rather than
   * writing back the previous account's evidence.
   */
  private evidenceEpoch = 0;
  private readonly observedPoolExhaustion: (() => ReadonlyMap<string, number>) | undefined;
  private readonly workBuddyAccountKinds: (() => Readonly<Record<string, string>>) | undefined;

  constructor(options: AutoRoutingQuotaSnapshotServiceOptions = {}) {
    this.queryJson = options.queryJson ?? queryQuotaJson;
    this.now = options.now ?? (() => Date.now());
    this.codeBuddySnapshot = options.codeBuddySnapshot;
    this.observedPoolExhaustion = options.observedPoolExhaustion;
    this.workBuddyAccountKinds = options.workBuddyAccountKinds;
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
   * Drops one provider's measured quota evidence after its account changed.
   *
   * The retained last-usable row of that provider is deleted, so a missing,
   * failed or stale read has no credit window of the previous account left to
   * fall back on inside the grace period, and every cached or in-flight
   * snapshot whose private context was built with that provider is dropped, so
   * a refresh started before the switch cannot keep or write back the previous
   * account's measured windows. Only that provider is affected; every other
   * provider keeps its retained row and existing grace behaviour.
   */
  invalidateProviderEvidence(providerId: string): void {
    this.evidenceEpoch += 1;
    this.lastUsableRows.delete(providerId);
    // Context keys carry providers as JSON keys of the login-type map.
    const marker = `"${providerId}"`;
    for (const key of [...this.cachedByContext.keys()]) {
      if (key.includes(marker)) this.cachedByContext.delete(key);
    }
    for (const key of [...this.inFlightByContext.keys()]) {
      if (key.includes(marker)) this.inFlightByContext.delete(key);
    }
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
    const workBuddyKinds = this.workBuddyAccountKinds?.() ?? {};
    const key = codeBuddyContextKey(context, workBuddyKinds);
    const nowMs = this.now();
    const cached = this.cachedByContext.get(key);
    if (cached !== undefined && cached.validUntilMs > nowMs) {
      return Object.freeze({ snapshot: cached, codeBuddySnapshot });
    }

    const pending = this.inFlightByContext.get(key);
    if (pending !== undefined) {
      return Object.freeze({ snapshot: await pending, codeBuddySnapshot });
    }

    const started = this.refresh(context, codeBuddySnapshot?.environment, workBuddyKinds).finally(() => {
      // Only this refresh's own registration may be removed: an invalidation
      // may have cleared the map and a newer refresh may already have
      // registered a replacement promise for the same context key.
      if (this.inFlightByContext.get(key) === started) this.inFlightByContext.delete(key);
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

  private async refresh(
    context: CodeBuddyQueryContext | undefined,
    environment?: string,
    workBuddyKinds: Readonly<Record<string, string>> = {},
  ): Promise<AutoRoutingQuotaSnapshot> {
    // Capture the epoch before the async query: any advance during the await
    // means an invalidation ran and everything this refresh measured belongs
    // to the previous account. Such a result is answered as unknown and must
    // not write retained rows, cache entries or failClosed state.
    const epoch = this.evidenceEpoch;
    let text: string;
    try {
      text = await this.queryJson(context);
    } catch {
      if (epoch !== this.evidenceEpoch) {
        return buildUnknownSnapshot(this.now(), [], this.lastUsableRows, environment, workBuddyKinds);
      }
      return this.failClosed(context, [], environment, workBuddyKinds);
    }
    if (epoch !== this.evidenceEpoch) {
      return buildUnknownSnapshot(this.now(), [], this.lastUsableRows, environment, workBuddyKinds);
    }
    // Evaluate provider observations against the time at which the asynchronous
    // sample completed. Wrenyard stamps each provider row as that provider
    // finishes, so sampling `now` before the query would incorrectly classify
    // ordinary rows produced during a slow refresh as future evidence. This
    // still rejects genuine clock-skewed future timestamps in rowUsable().
    const nowMs = this.now();
    try {
      const rows = parseQuotaReport(text);
      // Defense in depth: even an injected/misbehaving query source cannot
      // activate a CodeBuddy negative row without a complete current scope.
      const snapshot = buildSnapshot(
        rows,
        nowMs,
        context !== undefined,
        this.lastUsableRows,
        this.observedPoolExhaustion?.(),
        environment,
        workBuddyKinds,
      );
      if (snapshot === null) return this.failClosed(context, rows, environment, workBuddyKinds);
      this.cachedByContext.set(codeBuddyContextKey(context, workBuddyKinds), snapshot);
      return snapshot;
    } catch {
      return this.failClosed(context, [], environment, workBuddyKinds);
    }
  }

  private failClosed(
    context: CodeBuddyQueryContext | undefined,
    rows: readonly RawRow[] = [],
    environment?: string,
    workBuddyKinds: Readonly<Record<string, string>> = {},
  ): AutoRoutingQuotaSnapshot {
    // Never serve expired old evidence after a failed or empty refresh for the
    // current context; drop only that context's cache and hand back a
    // short-lived unknown snapshot. Other contexts (e.g. a previous login) can
    // never be served because they are keyed separately.
    this.cachedByContext.delete(codeBuddyContextKey(context, workBuddyKinds));
    return buildUnknownSnapshot(this.now(), rows, this.lastUsableRows, environment, workBuddyKinds);
  }
}
