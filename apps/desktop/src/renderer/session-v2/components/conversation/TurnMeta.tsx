import { Elapsed } from '@/renderer/components/elapsed';
import { Separator } from '@/renderer/components/ui/separator';
import { StatusBadge } from '@/renderer/components/status-badge';
import { formatTokenCount } from '@/renderer/lib/format';
import { statusView } from '../../model/describe.js';
import type { TurnModel } from '../../model/types.js';

function totalTokens(turn: TurnModel): number {
  const { expensive, cheap } = turn.stats;
  return (expensive.input ?? 0) + (expensive.output ?? 0) + (cheap.input ?? 0) + (cheap.output ?? 0);
}

/** Compact footer line: wall time · dispatches · total tokens. */
export function TurnMetaSummary({ turn }: { turn: TurnModel }) {
  return (
    <>
      <span>用时 <Elapsed start={turn.startedAt} end={turn.endedAt} /></span>
      <span>派发 {turn.stats.dispatches}</span>
      <span>总 token {formatTokenCount(totalTokens(turn))}</span>
    </>
  );
}

function UsageRow({ label, calls, input, cachedInput, output, reasoning }: {
  label: string;
  calls: number;
  input?: number;
  cachedInput?: number;
  output?: number;
  reasoning?: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="font-medium">{label}</span>
      <span>{calls} 次</span>
      <span>输入 {formatTokenCount(input)}</span>
      {cachedInput !== undefined && <span>缓存 {formatTokenCount(cachedInput)}</span>}
      <span>输出 {formatTokenCount(output)}</span>
      {reasoning !== undefined && <span>推理 {formatTokenCount(reasoning)}</span>}
    </div>
  );
}

export interface TurnMetaProps {
  turn: TurnModel;
}

/** Full turn statistics detail used by the footer hovercard and the inspector. */
export function TurnMeta({ turn }: TurnMetaProps) {
  const { expensive, cheap } = turn.stats;
  return (
    <div className="flex flex-col gap-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>墙钟 <Elapsed start={turn.startedAt} end={turn.endedAt} /></span>
        <span>派发 {turn.stats.dispatches}</span>
        <span>总 token {formatTokenCount(totalTokens(turn))}</span>
      </div>
      <Separator />
      <UsageRow label="昂贵调用" calls={expensive.calls} input={expensive.input} cachedInput={expensive.cachedInput} output={expensive.output} reasoning={expensive.reasoning} />
      <UsageRow label="便宜调用" calls={cheap.calls} input={cheap.input} output={cheap.output} />
      {(expensive.partial || cheap.partial) && <span>部分调用缺少用量数据</span>}
      <Separator />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>加载文档 {turn.stats.docsLoaded}</span>
        <span>写入文档 {turn.stats.docsWritten}</span>
        <span>推理模型 {turn.model.provider}/{turn.model.model}</span>
        {turn.model.reasoningEffort && <span>推理强度 {turn.model.reasoningEffort}</span>}
      </div>
      <div className="flex items-center gap-2">
        <span>终态</span>
        <StatusBadge {...statusView(turn.status)} />
      </div>
    </div>
  );
}
