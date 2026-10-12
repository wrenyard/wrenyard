import { useEffect, useMemo } from 'react';
import type { ContextInspection } from '@/shell-contract';
import { useQuotaQuery } from '@/renderer/lib/queries';
import { contextBudget, countInputTokens, growthByTurn, usageGroups } from '../../model/usage.js';
import type { SessionModel } from '../../model/types.js';
import { useSessionUsage } from '../../state/session-usage.js';
import { useSessionConsumption } from '../../state/use-session-consumption.js';
import { Section } from './parts.js';
import { OverviewCard } from './context/OverviewCard.js';
import { ModelPreviewTable } from './context/ModelPreviewTable.js';
import { ContextTree } from './context/ContextTree.js';
import { GrowthChart } from './context/GrowthChart.js';
import { CallSummary } from './context/CallSummary.js';

/**
 * Inspector "上下文" tab. It reads the shared selected model, loads the read-only
 * context inspection through `api.contextInspect`, and composes the overview,
 * model preview, composition, growth and call sections. Every token, fee and
 * grouping calculation lives in `model/usage.ts`; this file only wires the
 * query to those sections.
 */

export interface ContextTabProps {
  model: SessionModel;
}

export function ContextTab({ model }: ContextTabProps) {
  const { models, modelId, inputText, contextInspection, refreshContext, requestModel, requestInspection } = useSessionUsage();
  const consumption = useSessionConsumption();
  const inputTokens = useMemo(() => countInputTokens(inputText), [inputText]);
  const selected = models.find((entry) => entry.publicId === modelId);
  const quota = useQuotaQuery();

  useEffect(() => {
    refreshContext();
  }, [refreshContext]);

  const data = useMemo<ContextInspection>(() => contextInspection ?? {
    computedAtSeq: 0,
    estimator: 'o200k_base',
    model: { publicId: modelId },
    layers: [],
    items: [],
    totalTokens: 0,
  }, [contextInspection, modelId]);

  const budget = useMemo(() => contextBudget({ ...data, model: selected
    ? { publicId: selected.publicId, contextWindow: selected.contextWindow, maxOutputTokens: selected.maxOutputTokens }
    : data.model.publicId === modelId ? data.model : { publicId: modelId } }, inputTokens),
    [data, selected, modelId, inputTokens]);
  const groups = useMemo(() => usageGroups(data, inputTokens), [data, inputTokens]);
  const growth = useMemo(() => growthByTurn(data.items), [data]);
  const cacheRatio = consumption.sum.cacheRatio;

  if (modelId === '') {
    return <p className="text-sm text-muted-foreground">请在输入框选择模型后查看上下文占用</p>;
  }

  const endedTurns = growth.filter((entry) => model.turns.some((turn) => turn.id === entry.turn && turn.status !== 'running'));

  return (
    <div className="flex flex-col gap-4">
      <OverviewCard inspection={data} budget={budget} groups={groups} growth={endedTurns} cacheRatio={cacheRatio} />
      <ModelPreviewTable
        models={models}
        modelId={modelId}
        totalTokens={budget.total}
        cacheRatio={cacheRatio}
        quota={quota.data}
        onUseModel={requestModel}
      />
      <ContextTree inspection={data} onInspect={requestInspection} />
      <Section title="增长">
        <GrowthChart growth={growth} budget={budget} />
      </Section>
      <CallSummary calls={model.calls} quota={quota.data} />
    </div>
  );
}
