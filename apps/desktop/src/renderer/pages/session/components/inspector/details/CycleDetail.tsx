import { Elapsed } from '@/renderer/components/elapsed';
import { Timestamp } from '@/renderer/components/timestamp';
import { cycleLabel } from '../../../model/describe.js';
import type { CycleModel, InspectorTarget, TurnModel } from '../../../model/types.js';
import { Field, Fields } from '../parts.js';
import { CycleWork } from '../work/WorkSteps.js';

export interface CycleDetailProps {
  turn: TurnModel;
  cycle: CycleModel;
  onSelect: (target: InspectorTarget) => void;
}

/** One reasoning cycle: timing plus its complete work. */
export function CycleDetail({ turn, cycle }: CycleDetailProps) {
  return (
    <div className="flex flex-col gap-4">
      <Fields>
        <Field label="循环">{cycleLabel(cycle.index)}</Field>
        <Field label="开始"><Timestamp value={cycle.startedAt} precision="second" /></Field>
        {cycle.endedAt && <Field label="结束"><Timestamp value={cycle.endedAt} precision="second" /></Field>}
        <Field label="用时"><Elapsed start={cycle.startedAt} end={cycle.endedAt} /></Field>
      </Fields>
      <CycleWork turn={turn} cycle={cycle} />
    </div>
  );
}
