import { useCallback, useMemo } from 'react';
import type { ContextInspection, QuotaSnapshot } from '@/shell-contract';
import type { SessionRoutesPreviewResult, SessionRoutesPreviewRole } from '@wrenyard/protocol';
import {
  contextBudget,
  usageGroups,
  type ContextBudgetView,
  type UsageGroupView,
} from '../model/usage.js';
import { useQuotaQuery } from '@/renderer/lib/queries';
import { useSessionUsage } from './session-usage.js';

/**
 * Headless context-budget projection shared by the composer send-block and the
 * status-bar context item. It reads the shared session usage store for the model
 * list and the provider-owned context inspection and route preview, and derives
 * the budget and the composition groups. It also exposes a model resolver
 * (display name and context window) so callers can label each internal role's
 * context without a second source of truth. No JSX lives here.
 */

/** Display facts a caller can show for a model public id; fields are omitted when unknown. */
export interface ModelResolution {
  label?: string;
  contextWindow?: number;
}

export interface ContextBudgetState {
  inspection: ContextInspection | undefined;
  budget: ContextBudgetView | undefined;
  groups: UsageGroupView[];
  /**
   * Per-role auxiliary route preview from the daemon, including roles with no
   * call and roles with no usable route; undefined until the first result.
   */
  routesPreview: SessionRoutesPreviewResult | undefined;
  /** Resolve a model public id to its display name and context window, when known. */
  resolveModel(modelId: string): ModelResolution | undefined;
}

/** Catalog display name for a `provider/model` public id, when the catalog knows it. */
function catalogModelLabel(quota: QuotaSnapshot | undefined, publicId: string): string | undefined {
  const separator = publicId.indexOf('/');
  if (separator <= 0 || separator === publicId.length - 1) return undefined;
  const providerId = publicId.slice(0, separator);
  const modelId = publicId.slice(separator + 1);
  const provider = quota?.catalog?.find((catalog) => catalog.id === providerId);
  // The projection has exactly one identity: the registered model id. A
  // historical spelling is never silently resolved through a canonical fallback.
  return provider?.models?.find((candidate) => candidate.id === modelId)?.displayName;
}

export function useContextBudget(
  _sessionKey: string,
  modelId: string,
  inputTokens?: number,
): ContextBudgetState {
  const { models, contextInspection: inspection, contextRoutesPreview: routesPreview } = useSessionUsage();
  const quota = useQuotaQuery();
  const input = inputTokens ?? 0;

  const selected = models.find((entry) => entry.publicId === modelId);
  const budget = useMemo(() => {
    if (!inspection) return undefined;
    const model = selected
      ? { publicId: selected.publicId, contextWindow: selected.contextWindow, maxOutputTokens: selected.maxOutputTokens }
      : inspection.model.publicId === modelId ? inspection.model : { publicId: modelId };
    return contextBudget({ ...inspection, model }, input);
  }, [inspection, input, selected, modelId]);
  const groups = useMemo(() => (inspection ? usageGroups(inspection, input) : []), [inspection, input]);
  // Index the preview by its resolved model id so the resolver can prefer the
  // daemon's catalog facts over the renderer-side name/window lookups.
  const previewByModel = useMemo(() => {
    const map = new Map<string, SessionRoutesPreviewRole>();
    for (const entry of routesPreview?.roles ?? []) {
      if (entry.model !== undefined) map.set(entry.model, entry);
    }
    return map;
  }, [routesPreview]);
  const resolveModel = useCallback((targetId: string): ModelResolution | undefined => {
    const preview = previewByModel.get(targetId);
    if (preview !== undefined && (preview.modelName !== undefined || preview.contextWindow !== undefined)) {
      return {
        ...(preview.modelName === undefined ? {} : { label: preview.modelName }),
        ...(preview.contextWindow === undefined ? {} : { contextWindow: preview.contextWindow }),
      };
    }
    const target = models.find((entry) => entry.publicId === targetId);
    const inspectedWindow = inspection !== undefined && inspection.model.publicId === targetId
      ? inspection.model.contextWindow
      : undefined;
    const contextWindow = inspectedWindow ?? target?.contextWindow;
    const label = target?.displayName ?? catalogModelLabel(quota.data, targetId);
    if (label === undefined && contextWindow === undefined) return undefined;
    return {
      ...(label === undefined ? {} : { label }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    };
  }, [inspection, models, quota.data, previewByModel]);

  return { inspection, budget, groups, routesPreview, resolveModel };
}

