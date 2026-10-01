/**
 * Summary-model preference and settings projection.
 *
 * The conversation summary is an ordinary single-request LLM call against the
 * local Wrenyard Model Gateway — never the Task/DSH agent runtime. This module
 * owns only two pieces of that surface:
 *
 *   - the persisted canonical model preference, stored once per state root at
 *     `<stateRoot>/session/summary-model.json` (never per workspace, and never a
 *     credential or provider route);
 *   - the settings snapshot: the persisted choice plus every ordinary-LLM
 *     candidate the live Gateway can serve right now.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WrenyardGatewayConnection } from '@wrenyard/control-client';
import { createBuiltinCatalog } from '@wrenyard/providers';

/** Default canonical summary model. */
export const DEFAULT_SUMMARY_CANONICAL_MODEL = 'deepseek-v4.1-flash';

/** On-disk preference file version. */
const SUMMARY_MODEL_FILE_VERSION = 1;

/** One selectable ordinary-LLM option in the summary-model settings surface. */
export interface SummarySettingsOption {
  /** Canonical, provider-independent model identity the preference stores. */
  canonicalModel: string;
  /** Exact `provider/model` public id, present when a live route backs it. */
  publicId?: string;
  displayName: string;
  /** Provider display label emitted by the daemon gateway projection. */
  providerLabel?: string;
  /** False for the persisted selection when no live route backs it. */
  available: boolean;
}

/**
 * Projection of the summary-model settings surface. It carries no credential:
 * availability is always re-resolved from the live Gateway connection, and an
 * unknown selected canonical model stays listed so the user can see it.
 */
export interface SummarySettingsSnapshot {
  selectedCanonicalModel: string;
  options: SummarySettingsOption[];
  /** True when the live Gateway cannot back the selected canonical model. */
  unresolved: boolean;
  message?: string;
}

interface SummaryModelPreferenceFile {
  version: number;
  summaryModel: string;
}

/** Exact canonical id + provider route an availability is keyed by. */
interface SummaryGatewayCandidate {
  canonicalModel: string;
  /** Exact `provider/model` public id the local Gateway expects. */
  publicId: string;
  /** Provider-local declared model id, for the local-id fallback match. */
  model: string;
  displayName: string;
  providerLabel: string;
}

let catalog: ReturnType<typeof createBuiltinCatalog> | undefined;

function builtinCatalog(): ReturnType<typeof createBuiltinCatalog> {
  catalog ??= createBuiltinCatalog();
  return catalog;
}

function summaryModelPath(stateRoot: string): string {
  return join(stateRoot, 'session', 'summary-model.json');
}

/** Read the persisted canonical summary model, falling back to the default. */
export function readSummaryModel(stateRoot: string): string {
  const path = summaryModelPath(stateRoot);
  if (!existsSync(path)) return DEFAULT_SUMMARY_CANONICAL_MODEL;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return DEFAULT_SUMMARY_CANONICAL_MODEL;
    }
    const value = (parsed as { summaryModel?: unknown }).summaryModel;
    return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_SUMMARY_CANONICAL_MODEL;
  } catch {
    return DEFAULT_SUMMARY_CANONICAL_MODEL;
  }
}

/** Normalize and atomically persist the canonical summary model. */
export function saveSummaryModel(stateRoot: string, canonicalModel: string): void {
  const normalized = canonicalModel.trim();
  if (!normalized) throw new Error('摘要模型不能为空');
  const path = summaryModelPath(stateRoot);
  mkdirSync(dirname(path), { recursive: true });
  const payload: SummaryModelPreferenceFile = {
    version: SUMMARY_MODEL_FILE_VERSION,
    summaryModel: normalized,
  };
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

/**
 * Canonical identity for a gateway public id. The built-in catalog canonical
 * registry is the sole SSOT for canonical ids; a route without a registered
 * canonical model keeps its own provider-local declared model id (never a
 * label guess, and never inferred equivalence from another provider's id).
 */
function canonicalSummaryModelId(publicId: string): string {
  const separator = publicId.indexOf('/');
  if (separator <= 0 || separator === publicId.length - 1) return publicId;
  const providerId = publicId.slice(0, separator);
  const modelId = publicId.slice(separator + 1);
  const provider = builtinCatalog().provider(providerId);
  const resolvedModelId = provider?.modelAliases?.[modelId] ?? modelId;
  const definition = provider?.models.find((entry) => entry.id === resolvedModelId);
  return definition?.canonicalModel?.id ?? resolvedModelId;
}

/**
 * Enumerate the ordinary-LLM candidates the live Gateway can actually serve.
 * The gateway model list is already filtered to credentialed providers, so a
 * listed entry IS usable evidence. Task-only models are excluded: the summary
 * is an ordinary LLM call, never a task run.
 */
function summaryGatewayCandidates(connection: WrenyardGatewayConnection): SummaryGatewayCandidate[] {
  const labels = new Map<string, string>();
  for (const model of connection.models) {
    if (!labels.has(model.provider)) labels.set(model.provider, model.provider);
  }
  return connection.models
    .filter((model) =>
      model.taskOnly !== true && typeof model.publicId === 'string' && model.publicId.includes('/'))
    .map((model) => ({
      canonicalModel: canonicalSummaryModelId(model.publicId),
      publicId: model.publicId,
      model: model.publicId.slice(model.publicId.indexOf('/') + 1),
      displayName: model.displayName,
      providerLabel: labels.get(model.provider) ?? model.provider,
    }));
}

/** True when the selected canonical model resolves to a usable ordinary-LLM route. */
function hasUsableSummaryProvider(connection: WrenyardGatewayConnection, canonicalModel: string): boolean {
  const requested = canonicalModel.trim();
  return summaryGatewayCandidates(connection).some((candidate) =>
    candidate.canonicalModel === requested || candidate.model === requested);
}

/** Display name of a catalog model identified by canonical id, when declared. */
function catalogDisplayName(canonicalModel: string): string | undefined {
  for (const provider of builtinCatalog().providers()) {
    for (const model of provider.models) {
      if ((model.canonicalModel?.id ?? model.id) === canonicalModel) return model.displayName;
    }
  }
  return undefined;
}

/**
 * Project the summary-model settings surface: the persisted canonical model id
 * plus every ordinary-LLM candidate the live Gateway can serve right now.
 *
 * A candidate is only listed when the gateway projection carries it, because
 * that list is already filtered to credentialed providers. The persisted choice
 * always appears, marked unavailable when no usable route backs it, so the user
 * can see what is selected instead of silently losing it.
 */
export async function buildSummarySettingsSnapshot(options: {
  readGatewayConnection?: () => Promise<WrenyardGatewayConnection>;
  readSummaryModel?: () => string;
}): Promise<SummarySettingsSnapshot> {
  const selectedCanonicalModel = options.readSummaryModel?.() ?? '';
  let connection: WrenyardGatewayConnection | null = null;
  try {
    connection = (await options.readGatewayConnection?.()) ?? null;
  } catch {
    connection = null;
  }
  if (connection === null) {
    return {
      selectedCanonicalModel,
      options: [],
      unresolved: true,
      message: '本地模型网关不可用，暂时无法解析摘要模型。',
    };
  }
  const candidates = summaryGatewayCandidates(connection);
  const seen = new Set<string>();
  const projected: SummarySettingsOption[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.canonicalModel)) continue;
    seen.add(candidate.canonicalModel);
    projected.push({
      canonicalModel: candidate.canonicalModel,
      publicId: candidate.publicId,
      displayName: candidate.displayName,
      providerLabel: candidate.providerLabel,
      available: true,
    });
  }
  if (selectedCanonicalModel && !seen.has(selectedCanonicalModel)) {
    projected.push({
      canonicalModel: selectedCanonicalModel,
      displayName: catalogDisplayName(selectedCanonicalModel) ?? selectedCanonicalModel,
      available: false,
    });
  }
  return {
    selectedCanonicalModel,
    options: projected,
    unresolved: !hasUsableSummaryProvider(connection, selectedCanonicalModel),
  };
}
