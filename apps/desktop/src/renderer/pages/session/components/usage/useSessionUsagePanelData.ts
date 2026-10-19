import { useMemo } from 'react';
import { useDisplayCurrency, useQuotaQuery } from '@/renderer/lib/queries';
import type { DisplayCurrency } from '@/shell-contract';
import {
  mainSpeed,
  callModelGroups,
  metricClusters,
  roleContexts,
  taskModelGroups,
  type MetricCluster,
  type TaskModelGroup,
  type ContextBudgetView,
  type RoleContextEntry,
  type UsageGroupView,
} from '../../model/usage.js';
import { useSessionUsage, type SessionUsage } from '../../state/session-usage.js';
import { useContextBudget } from '../../state/use-context-budget.js';
import { useSessionConsumption, type SessionConsumption } from '../../state/use-session-consumption.js';
import type { ModelEntry } from '../../model/types.js';

export interface SessionUsagePanelData {
  models: readonly ModelEntry[];
  modelId: string;
  roles: RoleContextEntry[];
  budget: ContextBudgetView | undefined;
  groups: UsageGroupView[];
  clusters: readonly MetricCluster[];
  taskGroups: readonly TaskModelGroup[];
  callGroups: { reason: readonly TaskModelGroup[]; aux: readonly TaskModelGroup[] };
  missingTasks: number;
  runningTasks: number;
  currency: DisplayCurrency;
  speed: number | undefined;
}

function shortModel(model: string): string {
  const separator = model.indexOf('/');
  return separator > 0 && separator < model.length - 1 ? model.slice(separator + 1) : model;
}

export function useSessionUsagePanelData(
  usage?: Pick<SessionUsage, 'turns'> & { consumption?: SessionConsumption },
): SessionUsagePanelData {
  const { sessionKey, models, turns, modelId, inputTokens } = useSessionUsage();
  const { budget, groups, resolveModel, routesPreview } = useContextBudget(sessionKey, modelId, inputTokens);
  const providerConsumption = useSessionConsumption();
  const consumption = usage?.consumption ?? providerConsumption;
  const scopedTurns = usage?.turns ?? turns;

  const calls = useMemo(() => scopedTurns.flatMap((turn) => turn.calls), [scopedTurns]);
  const speed = useMemo(() => mainSpeed(calls), [calls]);
  const quota = useQuotaQuery();
  const currency = useDisplayCurrency();
  const dispatches = useMemo(
    () => scopedTurns.flatMap((turn) => turn.actions.filter((action) => action.kind === 'dispatch')),
    [scopedTurns],
  );
  const clusters = useMemo(
    () => metricClusters(calls, consumption.tasks, dispatches, quota.data),
    [calls, consumption.tasks, dispatches, quota.data],
  );
  const taskGroups = useMemo(
    () => taskModelGroups(consumption.tasks, dispatches),
    [consumption.tasks, dispatches],
  );
  const callGroups = useMemo(() => {
    const nameOf = (publicId: string): string =>
      models.find((entry) => entry.publicId === publicId)?.displayName ?? shortModel(publicId);
    const grouped = (role: 'reason' | 'aux'): TaskModelGroup[] => callModelGroups(
      calls.filter((call) => (role === 'reason' ? call.role === 'reason' : call.role !== 'reason')),
      quota.data,
      nameOf,
    );
    return { reason: grouped('reason'), aux: grouped('aux') };
  }, [calls, quota.data, models]);
  const roles = useMemo(
    () => roleContexts(calls, { reasonModel: modelId, resolve: resolveModel, preview: routesPreview?.roles }),
    [calls, modelId, resolveModel, routesPreview],
  );

  return {
    models,
    modelId,
    roles,
    budget,
    groups,
    clusters,
    taskGroups,
    callGroups,
    missingTasks: consumption.missingTasks,
    runningTasks: consumption.runningTasks,
    currency,
    speed,
  };
}
