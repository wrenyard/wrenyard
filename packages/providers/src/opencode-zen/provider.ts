import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { models } from '@wrenyard/models';
import { resolveWrenyardConfigRoot } from '@wrenyard/paths';
import type {
  ModelDefinition,
  Provider,
  ProviderCredential,
  ProviderDefinition,
  RoutingFreeSupplyFact,
} from '../base/index.ts';
import { model, resolveProviderModel } from '../base/model-defaults.ts';
import { validateOfferingSnapshot } from '../base/catalog.ts';
import { fetchOpenCodeFreeRows, type OpenCodeCatalogRow } from './catalog.ts';
import {
  definition as seedDefinition,
  paidModels,
  paidReasoningEffortMappings,
} from './models.ts';
import { quota } from './quota.ts';

/** The live free set is re-read every five minutes, like any other live supply. */
const SNAPSHOT_TTL_MS = 5 * 60_000;

/** A failed refresh keeps the last good publication and retries after this. */
const RETRY_BACKOFF_MS = 30_000;

export interface OpenCodeZenOptions {
  /** Injectable for deterministic catalogs; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface OpenCodeZenProvider extends Provider {
  refreshModels(): Promise<readonly ModelDefinition[]>;
  /** Live free promotion ids the unified registry does not register yet. */
  unregisteredFreeIds(): readonly string[];
}

interface Snapshot {
  readonly rows: readonly OpenCodeCatalogRow[];
  expires: number;
}

/**
 * The adapter owns no credential and no catalog state of its own. Paid routes
 * still authenticate through the Wrenyard-managed key store; this function only
 * reads that same store so the runtime's implementation branch keeps returning
 * the managed key instead of shadowing it with `undefined`. Free native routes
 * never reach this path in the availability check, so they stay credential-free.
 */
async function managedCredential(): Promise<ProviderCredential | undefined> {
  try {
    const path = join(resolveWrenyardConfigRoot(process.env, homedir()), 'providers', 'auth.json');
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const entry = (parsed as Record<string, unknown>)['opencode-zen'];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const { type, key } = entry as { type?: unknown; key?: unknown };
    if (type !== 'api' || typeof key !== 'string' || key.trim() === '') return undefined;
    return Object.freeze({ value: key.trim() });
  } catch {
    return undefined;
  }
}

/**
 * Live free promotion ids bound to an already-registered model family. The Zen
 * `-free` spelling is the exact upstream selector and stays private; the
 * published id, display name, intelligence, speed and pricing come from the
 * unified registry. A live row whose own id is registered binds to itself.
 *
 * Rows with no sourced identity stay unbound on purpose: `longcat-2.5-preview-free`
 * has no quantitative intelligence evidence or generation-rate definition for
 * the preview, and `space-bunny-free` is a stealth row with no verified lab,
 * intelligence or throughput source. Unbound rows remain diagnostic-only.
 */
const FREE_ROW_BINDINGS: Readonly<Record<string, string>> = {
  'beam-free': 'beam-1.0-501b-a23b',
  'glm-5.3-flash-free': 'glm-5.3-flash',
  'mimo-v2.5-free': 'mimo-v2.5',
  'mimo-v2.6-flash-free': 'mimo-v2.6-flash',
  'ling-3.0-flash-fin-free': 'ling-3.0-flash-fin',
  'nemotron-3-ultra-free': 'nemotron-3-ultra',
  'nemotron-3.5-lightning-free': 'nemotron-3.5-lightning',
  'nemotron-3.5-super-vl-free': 'nemotron-3.5-super-vl-120b-a12b',
};

/** One live free row resolved to the registered identity it may publish. */
interface LiveFreeRow {
  readonly identity: string;
  readonly row: OpenCodeCatalogRow;
}

/**
 * A live free row is usable only when it resolves to an identity the unified
 * registry already owns: the live catalog decides free status and availability,
 * registration is owned by the registry. Rows without a registered identity are
 * diagnostics only. When two upstream rows claim one identity, neither binding
 * is proven exact, so the identity is withheld instead of letting one win.
 */
function registeredFreeRows(rows: readonly OpenCodeCatalogRow[]): LiveFreeRow[] {
  const groups = new Map<string, OpenCodeCatalogRow[]>();
  for (const row of rows) {
    const identity = FREE_ROW_BINDINGS[row.id] ?? row.id;
    if (models.get(identity) === undefined) continue;
    const group = groups.get(identity);
    if (group === undefined) groups.set(identity, [row]);
    else group.push(row);
  }
  const resolved: LiveFreeRow[] = [];
  for (const [identity, group] of groups) {
    const row = group[0];
    if (group.length === 1 && row !== undefined) resolved.push({ identity, row });
  }
  return resolved;
}

/**
 * The live document supplies the promotion's current limits and ladder; the
 * registered identity supplies everything identity-owned. The upstream
 * selector stays the free promotion id.
 */
function liveFreeRow(entry: LiveFreeRow): ModelDefinition {
  return {
    ...resolveProviderModel(model(entry.identity, entry.row.context, entry.row.output, entry.row.id)),
    free: true,
    supportedClients: ['opencode'],
    reasoningEfforts: entry.row.efforts.length > 0 ? entry.row.efforts : ['default'],
    protocols: ['openai_chat', 'anthropic_messages'],
  };
}

/**
 * Explicit levels map to an effort alias; a ladder-less route is model-only.
 * The upstream selector is always the free promotion id.
 */
function liveFreeMapping(row: OpenCodeCatalogRow) {
  return row.efforts.length > 0
    ? { opencode: Object.fromEntries(row.efforts.map((level) => [level, { effort: level, model: row.id }])) }
    : { opencode: { default: { model: row.id } } };
}

export function createOpenCodeZen(options: OpenCodeZenOptions = {}): OpenCodeZenProvider {
  let current: Snapshot | undefined;
  let retryAt = 0;
  let pending: Promise<Snapshot> | undefined;
  // A private clone: live publication must never mutate the shared builtin
  // module, and provider-level fields (defaultModel, protocols, hooks,
  // conversion, speed evidence, copy) are only ever carried over untouched.
  const definition: ProviderDefinition = {
    ...seedDefinition,
    models: [...seedDefinition.models],
    reasoningEffortMappings: { ...(seedDefinition.reasoningEffortMappings ?? {}) },
  };

  const publish = (snapshot: Snapshot): void => {
    // Unregistered upstream rows stay in the snapshot for diagnostics only and
    // are never callable. A live free row replaces the paid offering of the
    // same identity, so one identity is never published twice.
    const freeRows = registeredFreeRows(snapshot.rows);
    const freeIds = new Set(freeRows.map((entry) => entry.identity));
    const offerings = [
      ...freeRows.map(liveFreeRow),
      ...paidModels.filter((entry) => !freeIds.has(entry.id)),
    ];
    const mappings = {
      ...Object.fromEntries(freeRows.map((entry) => [entry.identity, liveFreeMapping(entry.row)])),
      ...paidReasoningEffortMappings,
    };
    // A replacement snapshot obeys the same registered-identity, duplicate and
    // required-metadata contract as startup; an invalid snapshot is not published.
    validateOfferingSnapshot('opencode-zen', offerings, definition.protocols ?? []);
    definition.models = offerings;
    definition.reasoningEffortMappings = mappings;
    // A promotion leaving the catalog removes its speed override and measurement
    // provenance along with the row, so registration never sees a dangling override.
    const publishedIds = new Set(definition.models.map((entry) => entry.id));
    const overrides = Object.entries(definition.modelSpeedOverrides ?? {}).filter(([id]) =>
      publishedIds.has(id),
    );
    definition.modelSpeedOverrides = overrides.length === 0 ? undefined : Object.fromEntries(overrides);
    const measurements = Object.entries(definition.modelSpeedMeasurements ?? {}).filter(([id]) =>
      publishedIds.has(id),
    );
    definition.modelSpeedMeasurements =
      measurements.length === 0 ? undefined : Object.fromEntries(measurements);
  };

  // One in-flight request serves every caller. A failure keeps the last good
  // snapshot serving and backs off before the next attempt.
  const refresh = (): Promise<Snapshot> => {
    if (pending) return pending;
    // `pending` is never replaced while a request is in flight, so the finally
    // step can only clear this exact request.
    const request = fetchOpenCodeFreeRows(options.fetch === undefined ? {} : { fetch: options.fetch })
      .then((rows) => ({ rows, expires: Date.now() + SNAPSHOT_TTL_MS }))
      .then((snapshot) => {
        current = snapshot;
        retryAt = 0;
        publish(snapshot);
        return snapshot;
      })
      .catch((error: unknown) => {
        retryAt = Date.now() + RETRY_BACKOFF_MS;
        throw error;
      })
      .finally(() => {
        pending = undefined;
      });
    pending = request;
    return request;
  };

  return {
    id: 'opencode-zen',
    definition,
    clients: [],
    quota,
    credential: managedCredential,
    resolveModel: (model) => model,
    canonicalizeModel: (model) => model,
    applyHeaders() {},
    /**
     * Confirmed free only from a fresh live snapshot that still lists the
     * model. An expired snapshot starts exactly one background refresh and
     * makes no free claim until that evidence is replaced.
     */
    freeSupply(model: string): RoutingFreeSupplyFact | undefined {
      const snapshot = current;
      if (!snapshot) return undefined;
      if (snapshot.expires <= Date.now()) {
        if (retryAt <= Date.now()) void refresh().catch(() => undefined);
        return undefined;
      }
      return registeredFreeRows(snapshot.rows).some((entry) => entry.identity === model)
        ? { confirmedFree: true, source: 'opencode-zen.models_dev', ruleId: 'opencode-zen.zero_cost_active' }
        : undefined;
    },
    async refreshModels() {
      retryAt = 0;
      if (current) current.expires = 0;
      try {
        await refresh();
      } catch {
        // Offline startup is normal: the last good publication or the seed stays.
      }
      return definition.models;
    },
    /**
     * Unregistered upstream promotion ids are retained for diagnostics only.
     * Registration is owned by the unified registry, so the adapter never makes
     * one callable.
     */
    unregisteredFreeIds(): readonly string[] {
      return current === undefined
        ? []
        : current.rows
          .filter((row) => models.get(FREE_ROW_BINDINGS[row.id] ?? row.id) === undefined)
          .map((row) => row.id);
    },
  };
}
