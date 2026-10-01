import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { QueryError } from '@/renderer/components/query-error';
import { Spinner } from '@/renderer/components/ui/spinner';
import { useQuotaQuery } from '@/renderer/lib/queries';
import { contextQuery, useThrottledSeq } from '../../queries.js';
import { contextBudget, countInputTokens, growthByTurn, recentCacheRatio, usageGroups } from '../../model/usage.js';
import type { SessionModel } from '../../model/types.js';
import { useSessionUsage } from '../../state/session-usage.js';
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
  const { sessionKey, models, modelId, seq, inputText, requestModel, requestInspection } = useSessionUsage();
  const inputTokens = useMemo(() => countInputTokens(inputText), [inputText]);
  const selected = models.find((entry) => entry.publicId === modelId);
  const throttledSeq = useThrottledSeq(seq);
  const inspection = useQuery(contextQuery(sessionKey, modelId, throttledSeq));
  const quota = useQuotaQuery();

  const data = inspection.data;
  const budget = useMemo(() => data ? contextBudget({ ...data, model: selected
    ? { publicId: selected.publicId, contextWindow: selected.contextWindow, maxOutputTokens: selected.maxOutputTokens }
    : data.model.publicId === modelId ? data.model : { publicId: modelId } }, inputTokens) : undefined,
    [data, selected, modelId, inputTokens]);
  const groups = useMemo(() => (data ? usageGroups(data, inputTokens) : []), [data, inputTokens]);
  const growth = useMemo(() => (data ? growthByTurn(data.items) : []), [data]);
  const cacheRatio = useMemo(() => recentCacheRatio(model.calls), [model.calls]);

  if (modelId === '') {
    return <p className="text-sm text-muted-foreground">请在输入框选择模型后查看上下文占用</p>;
  }
  if (inspection.isError) {
    return <QueryError query={inspection} title="无法读取上下文检查结果" />;
  }
  if (!data || !budget) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        正在计算上下文…
      </div>
    );
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
