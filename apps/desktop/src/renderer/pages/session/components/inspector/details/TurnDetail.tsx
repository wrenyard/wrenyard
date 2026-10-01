import { Elapsed } from '@/renderer/components/elapsed';
import { StatusBadge } from '@/renderer/components/status-badge';
import { formatTokenCount } from '@/renderer/lib/format';
import { statusView } from '../../../model/describe.js';
import type { TurnModel } from '../../../model/types.js';
import { Field, Fields, Section } from '../parts.js';
import { WorkSteps } from '../work/WorkSteps.js';

function totalTokens(turn: TurnModel): number {
  const { expensive, cheap } = turn.stats;
  return (expensive.input ?? 0) + (expensive.output ?? 0) + (cheap.input ?? 0) + (cheap.output ?? 0);
}

/** Turn overview plus the full work process. */
export function TurnDetail({ turn }: { turn: TurnModel }) {
  const { expensive, cheap } = turn.stats;
  return (
    <div className="flex flex-col gap-4">
      <Section title="概览">
        <div className="flex flex-col gap-3">
          <Fields>
            <Field label="模型">{`${turn.model.provider}/${turn.model.model}`}</Field>
            {turn.model.reasoningEffort && <Field label="推理强度">{turn.model.reasoningEffort}</Field>}
            <Field label="状态"><StatusBadge {...statusView(turn.status)} /></Field>
          </Fields>
          <Fields>
            <Field label="墙钟"><Elapsed start={turn.startedAt} end={turn.endedAt} /></Field>
            <Field label="派发">{turn.stats.dispatches}</Field>
            <Field label="总 token">{formatTokenCount(totalTokens(turn))}</Field>
          </Fields>
          <Fields>
            <Field label="昂贵调用">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span>{expensive.calls} 次</span>
                <span>输入 {formatTokenCount(expensive.input)}</span>
                <span>缓存 {formatTokenCount(expensive.cachedInput)}</span>
                <span>输出 {formatTokenCount(expensive.output)}</span>
                <span>推理 {formatTokenCount(expensive.reasoning)}</span>
              </span>
            </Field>
            <Field label="便宜调用">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span>{cheap.calls} 次</span>
                <span>输入 {formatTokenCount(cheap.input)}</span>
                <span>输出 {formatTokenCount(cheap.output)}</span>
              </span>
            </Field>
            {(expensive.partial || cheap.partial) && <Field label="数据">部分调用缺少用量数据</Field>}
          </Fields>
        </div>
      </Section>
      <Section title="工作过程">
        <WorkSteps turn={turn} />
      </Section>
    </div>
  );
}
