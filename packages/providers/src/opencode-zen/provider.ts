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
 * A live free row is usable only when the unified registry already owns that
 * identity: the live catalog decides free status and availability for
 * registered models only, and registration is owned by the unified registry.
 * The registered canonical supplies display name, intelligence, pricing and
 * speed; the live document supplies the promotion id, its current limits and
 * its ladder.
 */
function liveFreeRow(row: OpenCodeCatalogRow): ModelDefinition {
  return {
    ...resolveProviderModel(model(row.id, row.context, row.output, row.id)),
    free: true,
    supportedClients: ['opencode'],
    reasoningEfforts: row.efforts.length > 0 ? row.efforts : ['default'],
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
    // are never callable: the live catalog decides free status and
    // availability for registered models only.
    const registered = snapshot.rows.filter((row) => models.get(row.id) !== undefined);
    definition.models = [...registered.map(liveFreeRow), ...paidModels];
    definition.reasoningEffortMappings = {
      ...Object.fromEntries(registered.map((row) => [row.id, liveFreeMapping(row)])),
      ...paidReasoningEffortMappings,
    };
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
      return snapshot.rows.some((row) => row.id === model)
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
        : current.rows.filter((row) => models.get(row.id) === undefined).map((row) => row.id);
    },
  };
}
