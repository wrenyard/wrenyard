/**
 * Focused node:test coverage for AutoRoutingQuotaSnapshotService.
 *
 * Fixtures mirror the REAL `forge quota --json` list DTO proven in
 * runtime/forge/internal/usage/quota: pool entries use `pool`/`status`/`stale`/
 * `fetched_at` (RFC3339 ISO string) plus `windows`; windows use `name`/`pct`/
 * `resets_at` (ISO string)/`window_minutes` (and the Go-emitted, never-read
 * `remaining_pct`). There is no `reset_kind`, `window_ms`, numeric id or epoch
 * timestamp anywhere.
 *
 * The suite proves: row location by binding.quotaProviderId while normalized
 * quotaPoolId is kept in output, used->remaining derivation with no clamping,
 * fail-closed missing/invalid/stale/future/over-60s observations, strict
 * rejection of an invented-field source, exact replenishment semantics from
 * binding window constraints (full-cycle carries reset pace; rolling/unknown
 * never invent one), the CodeBuddy retained block validated without
 * fetched_at (cache bounded by min(now+60s, reset); invalid/expired never
 * block), short-lived unknown snapshots for successful-but-empty reports, deep
 * immutability, single-flight deduplication, cache boundaries, expiry refresh
 * and the failed-refresh contract (expired evidence is never served).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROVIDER_QUOTA_BINDINGS } from '@wrenyard/providers';

import {
  AutoRoutingQuotaSnapshotService,
  type AutoRoutingQuotaSnapshot,
} from '../../lib/daemon/services/auto-routing-snapshot-service.mts';

const T0 = 1_726_000_000_000;
const MINUTE = 60_000;
const MONTH_MINUTES = 43_800;

const iso = (ms: number): string => new Date(ms).toISOString();

interface FixtureWindow {
  name: string;
  pct?: number | string;
  resets_at?: string;
  window_minutes?: number;
  remaining_pct?: number;
}

interface FixtureRow {
  pool: string;
  status?: string;
  stale?: boolean;
  fetched_at?: string;
  windows: FixtureWindow[];
}

type Binding = (typeof PROVIDER_QUOTA_BINDINGS)[number];

/** A declared required window element, narrowed past the optional `windows`
 *  property so indexed access stays strict-safe. */
type RequiredWindow = NonNullable<Binding['windows']>[number];

function reportJson(rows: unknown[]): string {
  return JSON.stringify(rows);
}

function serviceFor(rows: unknown[], now: () => number = () => T0): AutoRoutingQuotaSnapshotService {
  return new AutoRoutingQuotaSnapshotService({
    queryJson: () => Promise.resolve(reportJson(rows)),
    now,
  });
}

function entryFor(snapshot: AutoRoutingQuotaSnapshot, providerId: string, modelId: string) {
  const entry = snapshot.entries.find(
    (candidate) => candidate.providerId === providerId && candidate.modelId === modelId,
  );
  assert.ok(entry, `expected entry for ${providerId}/${modelId}`);
  return entry!;
}

function evidenceFor(snapshot: AutoRoutingQuotaSnapshot, providerId: string, modelId: string, windowId: string) {
  const entry = entryFor(snapshot, providerId, modelId);
  const constraint = entry.requiredQuota.find((candidate) => candidate.id === windowId);
  assert.ok(constraint, `expected constraint ${windowId} for ${providerId}/${modelId}`);
  return { entry, constraint: constraint! };
}

function windowConstraint(binding: Binding, windowId: string) {
  const constraint = binding.windows?.find((candidate) => candidate.windowId === windowId)
    ?? binding.pools?.flatMap((pool) => pool.windows).find((candidate) => candidate.windowId === windowId);
  assert.ok(constraint, `expected required window ${windowId} for ${binding.providerId}/${binding.modelId}`);
  return constraint!;
}

/**
 * Required constraint ids emitted for a binding. Legacy single-pool bindings
 * surface one id per declared window; a multi-pool binding surfaces every
 * jointly required pool, keyed by the normalized pool id whenever that pool
 * has no proven raw windows.
 */
function bindingRequiredConstraintIds(binding: Binding): string[] {
  const pools = binding.pools ?? [];
  if (pools.length > 0) {
    return pools.flatMap((pool) =>
      pool.windows.length === 0 ? [pool.quotaPoolId] : pool.windows.map((window) => window.windowId),
    );
  }
  return (binding.windows ?? []).map((window) => window.windowId);
}

/** Raw window ids a provider row would surface for a binding (actual windows only). */
function bindingRawWindowIds(binding: Binding): string[] {
  const pools = binding.pools ?? [];
  if (pools.length > 0) {
    return pools.flatMap((pool) => pool.windows.map((window) => window.windowId));
  }
  return (binding.windows ?? []).map((window) => window.windowId);
}

/** Mirrors the service mapping: unproven (and anything else) -> unknown. */
function expectedReplenishment(resetKind: unknown): string {
  if (resetKind === 'full_cycle') return 'full_cycle';
  if (resetKind === 'rolling_partial') return 'rolling_partial';
  return 'unknown';
}

function firstConstraintWithKind(kind: string): { binding: Binding; window: RequiredWindow } {
  for (const binding of PROVIDER_QUOTA_BINDINGS) {
    const windows = binding.windows ?? binding.pools?.flatMap((pool) => pool.windows) ?? [];
    for (const window of windows) {
      if (String(window.resetKind) === kind) return { binding, window };
    }
  }
  throw new Error(`no binding window with resetKind ${kind}`);
}

function rowsForBinding(
  binding: Binding,
  options: { pct: number; fetchedAtMs: number; extraWindows?: FixtureWindow[] },
): FixtureRow[] {
  // Only actual raw windows are ever surfaced on the provider row; pools with
  // no proven raw windows contribute no window object here.
  const windows: FixtureWindow[] = bindingRawWindowIds(binding).map((windowId) => ({
    name: windowId,
    pct: options.pct,
    resets_at: iso(options.fetchedAtMs + 3_600_000),
    window_minutes: MONTH_MINUTES,
  }));
  if (options.extraWindows) windows.push(...options.extraWindows);
  return [
    {
      pool: binding.quotaProviderId,
      status: 'ok',
      stale: false,
      fetched_at: iso(options.fetchedAtMs),
      windows,
    },
  ];
}

function rowsForAllBindings(fetchedAtMs: number, pct = 20): FixtureRow[] {
  const byPool = new Map<string, FixtureRow>();
  for (const binding of PROVIDER_QUOTA_BINDINGS) {
    const existing = byPool.get(binding.quotaProviderId);
    const row: FixtureRow = existing ?? {
      pool: binding.quotaProviderId,
      status: 'ok',
      stale: false,
      fetched_at: iso(fetchedAtMs),
      windows: [],
    };
    for (const windowId of bindingRawWindowIds(binding)) {
      if (!row.windows.some((present) => present.name === windowId)) {
        row.windows.push({
          name: windowId,
          pct,
          resets_at: iso(fetchedAtMs + 86_400_000),
          window_minutes: MONTH_MINUTES,
        });
      }
    }
    byPool.set(binding.quotaProviderId, row);
  }
  return [...byPool.values()];
}

function codebuddyRow(
  rowOverrides: Partial<FixtureRow> = {},
  windowOverrides: Partial<FixtureWindow> = {},
): FixtureRow {
  return {
    pool: 'codebuddy',
    status: 'ok',
    stale: false,
    // Intentionally NO fetched_at: Go emits this retained negative row without it.
    windows: [
      {
        name: '1mo',
        pct: 100,
        resets_at: iso(T0 + 3_600_000),
        window_minutes: MONTH_MINUTES,
        ...windowOverrides,
      },
    ],
    ...rowOverrides,
  };
}

// ---------------------------------------------------------------------------
// Real Go list DTO: mapping, derivation, replenishment semantics
// ---------------------------------------------------------------------------

test('maps every canonical binding from quotaProviderId rows and derives evidence', async () => {
  const rows = rowsForAllBindings(T0, 20);
  const snapshot = await serviceFor(rows).snapshot();

  assert.equal(snapshot.entries.length, PROVIDER_QUOTA_BINDINGS.length);
  for (const binding of PROVIDER_QUOTA_BINDINGS) {
    const entry = entryFor(snapshot, binding.providerId, binding.modelId);
    const isMultiPool = (binding.pools?.length ?? 0) > 0;
    // Required constraint ids cover every jointly required pool / declared window.
    assert.deepEqual(
      entry.requiredQuota.map((constraint) => constraint.id),
      bindingRequiredConstraintIds(binding),
    );
    if (isMultiPool) {
      // Normalized multi-pool ids are retained in output; no single quotaPoolId.
      assert.deepEqual([...entry.quotaPoolIds!], binding.pools!.map((pool) => pool.quotaPoolId));
      assert.equal(entry.quotaPoolId, undefined);
      for (const constraint of entry.requiredQuota) {
        // Pools without proven raw windows stay null constraints (unknown).
        assert.equal(constraint.evidence, null, `missing null evidence for ${binding.providerId} ${constraint.id}`);
      }
      continue;
    }
    // Normalized quotaPoolId is retained in output for legacy single-pool bindings.
    assert.equal(entry.quotaPoolId, binding.quotaPoolId);
    for (const constraint of entry.requiredQuota) {
      const evidence = constraint.evidence;
      assert.notEqual(evidence, null, `missing evidence for ${binding.providerId} ${constraint.id}`);
      assert.equal(evidence!.remainingPercent, 80);
      assert.equal(evidence!.observedAtMs, T0);
      assert.equal(evidence!.validForMs, 60_000);
      const resetKind = windowConstraint(binding, constraint.id).resetKind;
      assert.equal(evidence!.replenishmentKind, expectedReplenishment(resetKind));
      if (expectedReplenishment(resetKind) === 'full_cycle') {
        assert.equal(evidence!.resetAtMs, T0 + 86_400_000);
        assert.equal(evidence!.windowMs, MONTH_MINUTES * 60_000);
      } else {
        assert.ok(!('resetAtMs' in evidence!), `${constraint.id} must not invent a reset time`);
        assert.ok(!('windowMs' in evidence!), `${constraint.id} must not invent a window length`);
      }
    }
  }

  // Unrelated raw windows never become constraints even when present.
  const extra = rowsForBinding(PROVIDER_QUOTA_BINDINGS[0]!, {
    pct: 20,
    fetchedAtMs: T0,
    extraWindows: [{ name: 'zz-extra', pct: 5, resets_at: iso(T0 + 3_600_000), window_minutes: 60 }],
  });
  const withExtra = await serviceFor(extra).snapshot();
  const probe = PROVIDER_QUOTA_BINDINGS[0]!;
  const probed = entryFor(withExtra, probe.providerId, probe.modelId);
  assert.deepEqual(
    probed.requiredQuota.map((constraint) => constraint.id),
    probe.windows!.map((window) => window.windowId),
  );

  assert.deepEqual(snapshot.hardBlockedProviderIds, []);
});

// ---------------------------------------------------------------------------
// codebuddy/hy3 multi-pool: both empty required pools stay unknown constraints
// ---------------------------------------------------------------------------

test('codebuddy/hy3 direct snapshot requires both empty pools as null constraints', async () => {
  const binding = PROVIDER_QUOTA_BINDINGS.find(
    (candidate) => candidate.providerId === 'codebuddy' && candidate.modelId === 'hy3',
  );
  assert.ok(binding, 'expected a codebuddy/hy3 multi-pool binding');
  assert.equal(binding!.pools?.length, 2);

  // A fresh codebuddy row carrying only UNRELATED raw windows must not fabricate
  // either required pool constraint or any evidence for them.
  const unrelatedRawRow: FixtureRow = {
    pool: 'codebuddy',
    status: 'ok',
    stale: false,
    fetched_at: iso(T0),
    windows: [
      { name: '1h', pct: 20, resets_at: iso(T0 + 3_600_000), window_minutes: MONTH_MINUTES },
      { name: '5h', pct: 20, resets_at: iso(T0 + 3_600_000), window_minutes: MONTH_MINUTES },
    ],
  };
  const snapshot = await serviceFor([unrelatedRawRow]).snapshot();

  const entry = entryFor(snapshot, binding!.providerId, binding!.modelId);
  // Both jointly required pools are present; the legacy single quotaPoolId is not.
  assert.deepEqual([...entry.quotaPoolIds!], ['codebuddy-hy-family', 'codebuddy-monthly']);
  assert.equal(entry.quotaPoolId, undefined);
  assert.deepEqual(
    entry.requiredQuota.map((constraint) => constraint.id),
    ['codebuddy-hy-family', 'codebuddy-monthly'],
  );
  for (const constraint of entry.requiredQuota) {
    assert.equal(constraint.evidence, null, `pool ${constraint.id} must stay unknown without proven raw windows`);
  }
  // The fresh codebuddy row still yields a 60s direct snapshot (usable row),
  // while joint HY3 coverage stays incomplete (both constraints null).
  assert.equal(snapshot.validUntilMs, T0 + 60_000);
  assert.deepEqual(snapshot.hardBlockedProviderIds, []);
});

test('codebuddy/hy3 unknown snapshot keeps both empty pools required with null evidence', async () => {
  const rejecting = new AutoRoutingQuotaSnapshotService({
    queryJson: () => Promise.reject(new Error('forge quota unreachable')),
    now: () => T0,
  });
  const snapshot = await rejecting.snapshot();
  const binding = PROVIDER_QUOTA_BINDINGS.find(
    (candidate) => candidate.providerId === 'codebuddy' && candidate.modelId === 'hy3',
  );
  assert.ok(binding);

  const entry = entryFor(snapshot, binding!.providerId, binding!.modelId);
  assert.deepEqual([...entry.quotaPoolIds!], ['codebuddy-hy-family', 'codebuddy-monthly']);
  assert.deepEqual(
    entry.requiredQuota.map((constraint) => constraint.id),
    ['codebuddy-hy-family', 'codebuddy-monthly'],
  );
  for (const constraint of entry.requiredQuota) {
    assert.equal(constraint.evidence, null);
  }
  assert.equal(snapshot.validUntilMs, T0 + 15_000);
});

test('a raw codebuddy pct100 retained block never turns the empty HY3 pools into healthy evidence', async () => {
  const rows = [codebuddyRow()];
  const snapshot = await serviceFor(rows).snapshot();
  // The observed CodeBuddy exhaustion still hard-blocks the pool...
  assert.deepEqual(snapshot.hardBlockedProviderIds, ['codebuddy']);
  // ...but HY3 family+monthly pools remain required unknown constraints with
  // no fabricated raw rows, windows, or reset facts.
  const binding = PROVIDER_QUOTA_BINDINGS.find(
    (candidate) => candidate.providerId === 'codebuddy' && candidate.modelId === 'hy3',
  );
  assert.ok(binding);
  const entry = entryFor(snapshot, binding!.providerId, binding!.modelId);
  assert.deepEqual(
    entry.requiredQuota.map((constraint) => constraint.id),
    ['codebuddy-hy-family', 'codebuddy-monthly'],
  );
  for (const constraint of entry.requiredQuota) {
    assert.equal(constraint.evidence, null);
  }
});

test('rows are located by quotaProviderId, never by quotaPoolId, and output keeps quotaPoolId', async () => {
  const binding = PROVIDER_QUOTA_BINDINGS.find((candidate) => candidate.quotaPoolId !== candidate.quotaProviderId);
  assert.ok(binding, 'metadata must distinguish quotaPoolId from quotaProviderId');
  // This test intentionally selects a legacy single-pool binding, so its
  // normalized quotaPoolId is guaranteed present: pin it down before use.
  assert.ok(binding.quotaPoolId);
  const window = binding.windows![0]!;
  // The old invented shape keyed the raw row by quotaPoolId; the real DTO keys
  // it by quotaProviderId, so this row must NOT match any binding.
  const staleKeyedRow: FixtureRow = {
    pool: binding.quotaPoolId,
    status: 'ok',
    stale: false,
    fetched_at: iso(T0),
    windows: [{ name: window.windowId, pct: 20, resets_at: iso(T0 + 3_600_000), window_minutes: MONTH_MINUTES }],
  };
  const snapshot = await serviceFor([staleKeyedRow]).snapshot();
  const { constraint } = evidenceFor(snapshot, binding.providerId, binding.modelId, window.windowId);
  assert.equal(constraint.evidence, null, 'a quotaPoolId-keyed row must never match');
  // No fresh usable binding evidence and no block -> short unknown, never 60s cache.
  assert.equal(snapshot.validUntilMs, T0 + 15_000);
});

test('derives remainingPercent from raw used pct and never reads clamped remaining_pct', async () => {
  const { binding, window } = firstConstraintWithKind('full_cycle');
  // pct 120 is out-of-range; Go clamps remaining_pct to 0 in the window JSON.
  // The service must derive -20 and never consult the clamped 0.
  const extreme = await serviceFor(
    rowsForBinding(binding, { pct: 120, fetchedAtMs: T0 }).map((row) => ({
      ...row,
      windows: row.windows.map((w) => (w.name === window.windowId ? { ...w, remaining_pct: 0 } : w)),
    })),
  ).snapshot();
  const burned = evidenceFor(extreme, binding.providerId, binding.modelId, window.windowId);
  assert.equal(burned.constraint.evidence!.remainingPercent, -20);
  assert.equal(burned.constraint.evidence!.replenishmentKind, 'full_cycle');

  // pct 20 -> 80, still ignoring any emitted remaining_pct.
  const healthy = await serviceFor(
    rowsForBinding(binding, { pct: 20, fetchedAtMs: T0 }).map((row) => ({
      ...row,
      windows: row.windows.map((w) => (w.name === window.windowId ? { ...w, remaining_pct: 80 } : w)),
    })),
  ).snapshot();
  const fresh = evidenceFor(healthy, binding.providerId, binding.modelId, window.windowId);
  assert.equal(fresh.constraint.evidence!.remainingPercent, 80);
  assert.equal(fresh.constraint.evidence!.replenishmentKind, 'full_cycle');
});

// ---------------------------------------------------------------------------
// Real-invalid-source fixture: the previous invented field shape is inert
// ---------------------------------------------------------------------------

test('an invented-field raw source (id/reset_kind/window_ms/numeric timestamps) yields no usable evidence', async () => {
  const { binding, window } = firstConstraintWithKind('full_cycle');
  const inventedSource: unknown[] = [
    {
      pool: binding.quotaProviderId,
      status: 'ok',
      stale: false,
      fetched_at: T0, // numeric epoch: not a valid ISO fetched_at
      windows: [
        {
          id: window.windowId, // no `name`: not locatable
          pct: 30,
          reset_kind: 'full_cycle', // raw never carries this
          resets_at: T0 + 3_600_000, // numeric epoch, not ISO
          window_ms: 2_629_800_000, // raw never carries this
        },
      ],
    },
  ];
  const snapshot = await serviceFor(inventedSource).snapshot();
  const { constraint } = evidenceFor(snapshot, binding.providerId, binding.modelId, window.windowId);
  assert.equal(constraint.evidence, null, 'invented fields must not parse into evidence');
  assert.equal(snapshot.validUntilMs, T0 + 15_000, 'no usable rows -> short unknown');

  // A row with a valid ISO fetched_at but broken full-cycle pace fields is
  // fresh yet still yields null for the full-cycle window.
  const brokenPace: unknown[] = [
    {
      pool: binding.quotaProviderId,
      status: 'ok',
      stale: false,
      fetched_at: iso(T0),
      windows: [
        {
          name: window.windowId,
          pct: 30,
          resets_at: T0 + 3_600_000, // numeric epoch, not ISO
          window_minutes: undefined,
        },
      ],
    },
  ];
  const second = await serviceFor(brokenPace).snapshot();
  const paced = evidenceFor(second, binding.providerId, binding.modelId, window.windowId);
  assert.equal(paced.constraint.evidence, null, 'numeric resets_at / missing window_minutes must fail closed');
});

// ---------------------------------------------------------------------------
// Stale / error / future / missing fetched_at all fail closed
// ---------------------------------------------------------------------------

test('stale, non-ok, future and missing fetched_at rows all yield short unknown evidence', async () => {
  const binding = PROVIDER_QUOTA_BINDINGS[0]!;
  const windowId = binding.windows![0]!.windowId;
  const base = (overrides: Partial<FixtureRow>): FixtureRow[] => [
    { ...rowsForBinding(binding, { pct: 20, fetchedAtMs: T0 })[0]!, ...overrides },
  ];

  const cases: Array<{ name: string; rows: FixtureRow[] }> = [
    { name: 'stale row', rows: base({ stale: true }) },
    { name: 'status error', rows: base({ status: 'error' }) },
    { name: 'future fetched_at', rows: base({ fetched_at: iso(T0 + 5_000) }) },
    { name: 'missing fetched_at', rows: base({ fetched_at: undefined }) },
  ];

  for (const scenario of cases) {
    const snapshot = await serviceFor(scenario.rows).snapshot();
    const { constraint } = evidenceFor(snapshot, binding.providerId, binding.modelId, windowId);
    assert.equal(constraint.evidence, null, scenario.name);
    assert.equal(snapshot.validUntilMs, T0 + 15_000, scenario.name);
    assert.deepEqual(snapshot.hardBlockedProviderIds, [], scenario.name);
  }
});

// ---------------------------------------------------------------------------
// Freshness: 60s window for normal rows
// ---------------------------------------------------------------------------

test('normal rows older than 60 seconds are unknown, never a 60s successful cache', async () => {
  let calls = 0;
  const binding = PROVIDER_QUOTA_BINDINGS[0]!;
  const windowId = binding.windows![0]!.windowId;
  const rows = rowsForBinding(binding, { pct: 20, fetchedAtMs: T0 - 70_000 });
  const service = new AutoRoutingQuotaSnapshotService({
    queryJson: () => {
      calls += 1;
      return Promise.resolve(reportJson(rows));
    },
    now: () => T0,
  });

  const first = await service.snapshot();
  assert.equal(first.validUntilMs, T0 + 15_000);
  assert.equal(
    evidenceFor(first, binding.providerId, binding.modelId, windowId).constraint.evidence,
    null,
    'a 70s-old fetched_at is outside the 60s freshness window',
  );

  // The unknown snapshot is not cached: an immediate call must re-query rather
  // than serve a fabricated 60s success.
  const second = await service.snapshot();
  assert.equal(calls, 2);
  assert.equal(second.validUntilMs, T0 + 15_000);
});

test('a 30s-old row still yields evidence but bounds the cache to its remaining freshness', async () => {
  const binding = PROVIDER_QUOTA_BINDINGS[0]!;
  const windowId = binding.windows![0]!.windowId;
  const snapshot = await serviceFor(rowsForBinding(binding, { pct: 20, fetchedAtMs: T0 - 30_000 })).snapshot();
  assert.equal(snapshot.validUntilMs, T0 + 30_000, 'valid until fetched_at + 60s');
  assert.notEqual(
    evidenceFor(snapshot, binding.providerId, binding.modelId, windowId).constraint.evidence,
    null,
  );
});

test('a report with only an unrelated fresh pool is a short unknown, not a 60s cache', async () => {
  const unrelated: FixtureRow[] = [
    { pool: 'some-other-pool', status: 'ok', stale: false, fetched_at: iso(T0), windows: [] },
  ];
  const snapshot = await serviceFor(unrelated).snapshot();
  assert.equal(snapshot.validUntilMs, T0 + 15_000);
  for (const entry of snapshot.entries) {
    for (const constraint of entry.requiredQuota) {
      assert.equal(constraint.evidence, null);
    }
  }
});

// ---------------------------------------------------------------------------
// Replenishment semantics come from binding constraints, not raw reset_kind
// ---------------------------------------------------------------------------

test('full-cycle windows require a valid parsed reset time and window_minutes', async () => {
  const { binding, window } = firstConstraintWithKind('full_cycle');

  const noReset = await serviceFor(
    rowsForBinding(binding, { pct: 30, fetchedAtMs: T0 }).map((row) => ({
      ...row,
      windows: row.windows.map((w) => (w.name === window.windowId ? { ...w, resets_at: undefined } : w)),
    })),
  ).snapshot();
  assert.equal(
    evidenceFor(noReset, binding.providerId, binding.modelId, window.windowId).constraint.evidence,
    null,
    'missing resets_at must null a full-cycle window',
  );

  const noMinutes = await serviceFor(
    rowsForBinding(binding, { pct: 30, fetchedAtMs: T0 }).map((row) => ({
      ...row,
      windows: row.windows.map((w) => (w.name === window.windowId ? { ...w, window_minutes: undefined } : w)),
    })),
  ).snapshot();
  assert.equal(
    evidenceFor(noMinutes, binding.providerId, binding.modelId, window.windowId).constraint.evidence,
    null,
    'missing window_minutes must null a full-cycle window',
  );

  const garbageReset = await serviceFor(
    rowsForBinding(binding, { pct: 30, fetchedAtMs: T0 }).map((row) => ({
      ...row,
      windows: row.windows.map((w) => (w.name === window.windowId ? { ...w, resets_at: 'not-a-time' } : w)),
    })),
  ).snapshot();
  assert.equal(
    evidenceFor(garbageReset, binding.providerId, binding.modelId, window.windowId).constraint.evidence,
    null,
    'an unparseable ISO resets_at must null a full-cycle window',
  );
});

test('rolling_partial and unproven binding windows never carry a reset pace', async () => {
  for (const kind of ['rolling_partial', 'unproven']) {
    let matched: { binding: Binding; window: RequiredWindow } | undefined;
    try {
      matched = firstConstraintWithKind(kind);
    } catch {
      // The dataset does not contain this kind; nothing to assert.
      continue;
    }
    const snapshot = await serviceFor(rowsForBinding(matched.binding, { pct: 20, fetchedAtMs: T0 })).snapshot();
    const { constraint } = evidenceFor(
      snapshot,
      matched.binding.providerId,
      matched.binding.modelId,
      matched.window.windowId,
    );
    assert.equal(constraint.evidence!.remainingPercent, 80);
    assert.equal(constraint.evidence!.replenishmentKind, expectedReplenishment(kind));
    assert.ok(!('resetAtMs' in constraint.evidence!), `${kind} must not invent a reset time`);
    assert.ok(!('windowMs' in constraint.evidence!), `${kind} must not invent a window length`);
  }
});

test('a missing required window stays an explicit null constraint', async () => {
  // PROVIDER_QUOTA_BINDINGS[0] (Cursor) declares a single window, so use the
  // two-window kimi-coding/k3 binding and remove only its first window.
  const binding = PROVIDER_QUOTA_BINDINGS.find(
    (candidate) => candidate.providerId === 'kimi-coding' && candidate.modelId === 'k3',
  );
  assert.ok(binding, 'expected a kimi-coding/k3 binding');
  assert.ok(binding!.windows!.length >= 2, 'the kimi-coding/k3 binding must declare two required windows');
  const missingId = binding!.windows![0]!.windowId;
  const presentId = binding!.windows![1]!.windowId;
  const rows = rowsForBinding(binding!, { pct: 20, fetchedAtMs: T0 }).map((row) => ({
    ...row,
    windows: row.windows.filter((window) => window.name !== missingId),
  }));
  const snapshot = await serviceFor(rows).snapshot();
  const missing = evidenceFor(snapshot, binding!.providerId, binding!.modelId, missingId);
  const present = evidenceFor(snapshot, binding!.providerId, binding!.modelId, presentId);
  assert.equal(missing.constraint.evidence, null);
  assert.equal(missing.constraint.id, missingId);
  assert.notEqual(present.constraint.evidence, null);
});

// ---------------------------------------------------------------------------
// CodeBuddy hard block: retained negative row WITHOUT fetched_at
// ---------------------------------------------------------------------------

test('CodeBuddy pct100 with future ISO reset hard-blocks without any fetched_at', async () => {
  const snapshot = await serviceFor([codebuddyRow()]).snapshot();
  assert.deepEqual(snapshot.hardBlockedProviderIds, ['codebuddy']);
  // Far-future reset: the retained block is bounded by the now + 60s cap.
  assert.equal(snapshot.validUntilMs, T0 + 60_000);
});

test('the CodeBuddy cache boundary respects the reset when it is inside the 60s cap', async () => {
  const snapshot = await serviceFor([codebuddyRow({}, { resets_at: iso(T0 + 30_000) })]).snapshot();
  assert.deepEqual(snapshot.hardBlockedProviderIds, ['codebuddy']);
  assert.equal(snapshot.validUntilMs, T0 + 30_000, 'bounded by min(now+60s, reset)');
});

test('a stale fetched_at on the CodeBuddy retained row is ignored for the block', async () => {
  const snapshot = await serviceFor([
    codebuddyRow({ fetched_at: iso(T0 - 120_000) }, { resets_at: iso(T0 + 3_600_000) }),
  ]).snapshot();
  assert.deepEqual(snapshot.hardBlockedProviderIds, ['codebuddy']);
  assert.equal(snapshot.validUntilMs, T0 + 60_000);
});

test('CodeBuddy absence, invalid or expired observations never hard-block', async () => {
  const cases: Array<{ name: string; rows: FixtureRow[] }> = [
    { name: 'absent pool', rows: [] },
    { name: 'pct 99', rows: [codebuddyRow({}, { pct: 99 })] },
    { name: 'pct string', rows: [codebuddyRow({}, { pct: '100' })] },
    { name: 'wrong window name', rows: [codebuddyRow({}, { name: '1h' })] },
    { name: 'expired reset', rows: [codebuddyRow({}, { resets_at: iso(T0 - 1_000) })] },
    { name: 'missing reset', rows: [codebuddyRow({}, { resets_at: undefined })] },
    { name: 'garbage reset', rows: [codebuddyRow({}, { resets_at: 'not-a-time' })] },
    { name: 'status error', rows: [codebuddyRow({ status: 'error' })] },
    { name: 'stale row', rows: [codebuddyRow({ stale: true })] },
    { name: 'no 1mo window', rows: [codebuddyRow({ windows: [] })] },
  ];

  for (const scenario of cases) {
    const snapshot = await serviceFor(scenario.rows).snapshot();
    assert.deepEqual(snapshot.hardBlockedProviderIds, [], scenario.name);
    // Without a valid block and with no binding rows this is a short unknown,
    // proving invalid/expired observations produce no retained signal.
    assert.equal(snapshot.validUntilMs, T0 + 15_000, scenario.name);
  }
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

test('snapshots are deeply frozen at every level', async () => {
  const rows = rowsForAllBindings(T0);
  rows.push(codebuddyRow());
  const snapshot = await serviceFor(rows).snapshot();

  const entry = snapshot.entries[0]!;
  const constraint = entry.requiredQuota[0]!;
  const evidence = constraint.evidence;

  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.entries));
  assert.ok(Object.isFrozen(snapshot.hardBlockedProviderIds));
  assert.ok(Object.isFrozen(entry));
  assert.ok(Object.isFrozen(entry.requiredQuota));
  assert.ok(Object.isFrozen(constraint));
  assert.ok(evidence !== null && Object.isFrozen(evidence));

  assert.throws(() => {
    (snapshot as unknown as { nowMs: number }).nowMs = 0;
  }, TypeError);
  assert.throws(() => {
    (entry.requiredQuota[0] as unknown as { evidence: unknown }).evidence = null;
  }, TypeError);
  assert.throws(() => {
    (snapshot.hardBlockedProviderIds as string[]).push('codebuddy');
  }, TypeError);
});

// ---------------------------------------------------------------------------
// Concurrency, caching, expiry and failure contracts
// ---------------------------------------------------------------------------

test('concurrent snapshot requests share one in-flight query', async () => {
  let calls = 0;
  let release!: (value: string) => void;
  const service = new AutoRoutingQuotaSnapshotService({
    queryJson: () => {
      calls += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    },
    now: () => T0,
  });

  const first = service.snapshot();
  const second = service.snapshot();
  release(reportJson(rowsForAllBindings(T0)));

  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a, b);
});

test('serves the cached snapshot until the earliest 60s freshness boundary', async () => {
  let calls = 0;
  let current = T0;
  const binding = PROVIDER_QUOTA_BINDINGS[0]!;
  const rows = rowsForBinding(binding, { pct: 20, fetchedAtMs: T0 });
  const queryJson = () => {
    calls += 1;
    return Promise.resolve(reportJson(rows));
  };
  const service = new AutoRoutingQuotaSnapshotService({ queryJson, now: () => current });

  const first = await service.snapshot();
  assert.equal(calls, 1);
  assert.equal(first.validUntilMs, T0 + 60_000);

  current = T0 + 30_000; // well before the boundary
  const second = await service.snapshot();
  assert.equal(second, first);
  assert.equal(calls, 1);
});

test('refresh happens after expiry and produces a fresh snapshot', async () => {
  let calls = 0;
  let current = T0;
  const binding = PROVIDER_QUOTA_BINDINGS[0]!;
  const windowId = binding.windows![0]!.windowId;
  const queryJson = () => {
    calls += 1;
    const pct = current === T0 ? 20 : 60;
    return Promise.resolve(reportJson(rowsForBinding(binding, { pct, fetchedAtMs: current })));
  };
  const service = new AutoRoutingQuotaSnapshotService({ queryJson, now: () => current });

  const first = await service.snapshot();
  assert.equal(first.validUntilMs, T0 + 60_000);
  assert.equal(
    evidenceFor(first, binding.providerId, binding.modelId, windowId).constraint.evidence!.remainingPercent,
    80,
  );

  current = T0 + 61_000; // past the cached boundary
  const second = await service.snapshot();
  assert.equal(calls, 2);
  assert.notEqual(second, first);
  assert.equal(second.nowMs, current);
  assert.equal(second.validUntilMs, current + 60_000);
  assert.equal(
    evidenceFor(second, binding.providerId, binding.modelId, windowId).constraint.evidence!.remainingPercent,
    40,
  );
});

test('a failed refresh never serves expired old evidence and returns a short-lived unknown snapshot', async () => {
  let calls = 0;
  let current = T0;
  const binding = PROVIDER_QUOTA_BINDINGS[0]!;
  const windowId = binding.windows![0]!.windowId;
  const queryJson = () => {
    calls += 1;
    if (current > T0 + 60_000) return Promise.reject(new Error('forge quota unreachable'));
    return Promise.resolve(reportJson(rowsForBinding(binding, { pct: 20, fetchedAtMs: T0 })));
  };
  const service = new AutoRoutingQuotaSnapshotService({ queryJson, now: () => current });

  const healthy = await service.snapshot();
  assert.notEqual(
    evidenceFor(healthy, binding.providerId, binding.modelId, windowId).constraint.evidence,
    null,
  );

  current = T0 + 120_000; // healthy is long expired
  const unknown = await service.snapshot();
  assert.equal(calls, 2);
  assert.notEqual(unknown, healthy);
  assert.equal(unknown.nowMs, current);
  assert.equal(unknown.validUntilMs, current + 15_000); // short-lived
  assert.deepEqual(unknown.hardBlockedProviderIds, []);
  for (const entry of unknown.entries) {
    for (const constraint of entry.requiredQuota) {
      assert.equal(constraint.evidence, null, 'failed refresh must not recycle old evidence');
    }
  }

  // Even after the unknown snapshot lapses, a still-failing query keeps
  // returning unknown snapshots and never the expired old one.
  current = current + 20_000;
  const again = await service.snapshot();
  assert.equal(calls, 3);
  assert.notEqual(again, healthy);
  assert.equal(again.validUntilMs, again.nowMs + 15_000);
  for (const entry of again.entries) {
    for (const constraint of entry.requiredQuota) {
      assert.equal(constraint.evidence, null);
    }
  }
});

test('the snapshot DTO carries no credentials', async () => {
  const rows = rowsForAllBindings(T0);
  rows.push(codebuddyRow());
  const direct = await serviceFor(rows).snapshot();

  const rejecting = new AutoRoutingQuotaSnapshotService({
    queryJson: () => Promise.reject(new Error('boom')),
    now: () => T0,
  });
  const unknown = await rejecting.snapshot();

  // Structural key-name traversal (case/separator-insensitive) rather than
  // substring matching over the serialized blob: legitimate pool ids such as
  // 'zhipu-coding-tokens' must never be flagged as a credential value.
  const forbiddenKeys = new Set(
    [
      'access_token',
      'token',
      'secret',
      'credential',
      'api_key',
      'apikey',
      'authorization',
      'password',
      'bearer',
    ].map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, '')),
  );

  const assertNoCredentialKeys = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        assertNoCredentialKeys(item, `${path}[${index}]`);
      }
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        assert.ok(!forbiddenKeys.has(normalized), `DTO must not carry a credential key at ${path}.${key}`);
        assertNoCredentialKeys(nested, `${path}.${key}`);
      }
    }
  };

  for (const snapshot of [direct, unknown]) {
    assertNoCredentialKeys(JSON.parse(JSON.stringify(snapshot)), '$');
  }
});
