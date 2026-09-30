import { Button } from '@/renderer/components/ui/button';
import { Elapsed } from '@/renderer/components/elapsed';
import { Timestamp } from '@/renderer/components/timestamp';
import { PHASE_LABEL, cycleLabel, materialTitle } from '../../../model/describe.js';
import type { CycleModel, InspectorTarget, TurnModel } from '../../../model/types.js';
import { Field, InspectLink, Section, findAction } from '../parts.js';

/** One reasoning cycle: timing plus its prepared context and actions. */
export function CycleDetail({ turn, cycle, onSelect }: { turn: TurnModel; cycle: CycleModel; onSelect: (target: InspectorTarget) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="循环">{cycleLabel(cycle.index)}</Field>
      <Field label="开始"><Timestamp value={cycle.startedAt} precision="second" className="font-mono text-xs" /></Field>
      {cycle.endedAt && <Field label="结束"><Timestamp value={cycle.endedAt} precision="second" className="font-mono text-xs" /></Field>}
      <Field label="用时"><Elapsed start={cycle.startedAt} end={cycle.endedAt} /></Field>
      {cycle.reasoning && (
        <Section title={PHASE_LABEL.reasoning}>
          <Button variant="outline" size="sm" onClick={() => onSelect({ kind: 'reasoning', turnId: turn.id, cycle: cycle.index })}>
            查看推理全文
          </Button>
        </Section>
      )}
      {cycle.context.length > 0 && (
        <Section title={PHASE_LABEL.preparing}>
          <div className="flex flex-col gap-1">
            {cycle.context.map((item) => (
              <InspectLink key={item.key} onClick={() => onSelect({ kind: 'context', turnId: turn.id, cycle: cycle.index, key: item.key })}>
                {materialTitle(item)}
              </InspectLink>
            ))}
          </div>
        </Section>
      )}
      {cycle.actionIds.length > 0 && (
        <Section title={PHASE_LABEL.acting}>
          <div className="flex flex-col gap-1">
            {cycle.actionIds.map((actionId) => (
              <InspectLink key={actionId} onClick={() => onSelect({ kind: 'action', turnId: turn.id, actionId })}>
                {findAction(turn, actionId)?.title ?? actionId}
              </InspectLink>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
