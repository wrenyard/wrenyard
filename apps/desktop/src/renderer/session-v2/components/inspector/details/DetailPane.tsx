import { ChevronRight } from 'lucide-react';
import { cycleLabel } from '../../../model/describe.js';
import { Separator } from '@/renderer/components/ui/separator';
import type { InspectorTarget, SessionModel } from '../../../model/types.js';
import { EmptyNote, findAction, findBlock, findContext, findCycle, findTurn } from '../parts.js';
import { ActionDetail } from './ActionDetail.js';
import { BlockDetail } from './BlockDetail.js';
import { CallDetail } from './CallDetail.js';
import { CycleDetail } from './CycleDetail.js';
import { MaterialDetail } from './MaterialDetail.js';
import { ReasoningDetail } from './ReasoningDetail.js';
import { TurnDetail } from './TurnDetail.js';

interface Crumb {
  label: string;
  target?: InspectorTarget;
}

function breadcrumbs(model: SessionModel, target: InspectorTarget): Crumb[] {
  if (target.kind === 'call') {
    const call = model.calls.find((candidate) => candidate.id === target.callId);
    const turn = call ? findTurn(model, call.turn) : undefined;
    const crumbs: Crumb[] = [];
    if (turn) {
      crumbs.push({ label: `轮次 ${turn.id}`, target: { kind: 'turn', turnId: turn.id } });
      if (call?.cycle) {
        crumbs.push({ label: cycleLabel(call.cycle), target: { kind: 'cycle', turnId: turn.id, cycle: call.cycle } });
      }
    }
    crumbs.push({ label: target.callId });
    return crumbs;
  }
  const turn = findTurn(model, target.turnId);
  if (!turn) return [{ label: '详情' }];
  const crumbs: Crumb[] = [{ label: `轮次 ${turn.id}`, target: { kind: 'turn', turnId: turn.id } }];
  if (target.kind === 'turn') return crumbs;
  if (target.kind === 'cycle' || target.kind === 'reasoning') {
    crumbs.push({ label: cycleLabel(target.cycle) });
    return crumbs;
  }
  const cycle = target.kind === 'action'
    ? findAction(turn, target.actionId)?.cycle
    : target.kind === 'block'
      ? findBlock(turn, target.blockId)?.cycle.index
      : target.kind === 'context'
        ? target.cycle ?? findContext(turn, target.key)?.cycle?.index
        : undefined;
  if (cycle !== undefined && cycle > 0) {
    crumbs.push({ label: cycleLabel(cycle), target: { kind: 'cycle', turnId: turn.id, cycle } });
  }
  const leaf = target.kind === 'action' ? target.actionId : target.kind === 'block' ? target.blockId : target.kind === 'context' ? '资料' : '推理';
  crumbs.push({ label: leaf });
  return crumbs;
}

function TargetBody({ model, target, onSelect }: { model: SessionModel; target: InspectorTarget; onSelect: (target: InspectorTarget) => void }) {
  if (target.kind === 'call') {
    const call = model.calls.find((candidate) => candidate.id === target.callId);
    return call ? <CallDetail call={call} /> : <EmptyNote text="找不到这个调用" />;
  }
  const turn = findTurn(model, target.turnId);
  if (!turn) return <EmptyNote text="找不到这个轮次" />;

  switch (target.kind) {
    case 'turn':
      return <TurnDetail turn={turn} />;
    case 'cycle': {
      const cycle = findCycle(turn, target.cycle);
      return cycle ? <CycleDetail turn={turn} cycle={cycle} onSelect={onSelect} /> : <EmptyNote text="找不到这个循环" />;
    }
    case 'reasoning': {
      const cycle = findCycle(turn, target.cycle);
      return cycle?.reasoning ? <ReasoningDetail reasoning={cycle.reasoning} onSelect={onSelect} /> : <EmptyNote text="没有推理内容" />;
    }
    case 'context': {
      const found = findContext(turn, target.key);
      return found ? <MaterialDetail item={found.item} /> : <EmptyNote text="找不到这份资料" />;
    }
    case 'action': {
      const action = findAction(turn, target.actionId);
      return action ? <ActionDetail turn={turn} action={action} onSelect={onSelect} /> : <EmptyNote text="找不到这个行动" />;
    }
    case 'block': {
      const found = findBlock(turn, target.blockId);
      return found ? <BlockDetail turn={turn} block={found.block} cycle={found.cycle} onSelect={onSelect} /> : <EmptyNote text="找不到这个标注块" />;
    }
  }
}

export interface DetailPaneProps {
  model: SessionModel;
  target: InspectorTarget | undefined;
  onSelect: (target: InspectorTarget) => void;
}

/** Details of the inspected object; defaults to the latest turn. */
export function DetailPane({ model, target, onSelect }: DetailPaneProps) {
  const resolved: InspectorTarget = target ?? (model.turns.length > 0
    ? { kind: 'turn', turnId: model.turns[model.turns.length - 1]!.id }
    : { kind: 'turn', turnId: 0 });
  const crumbs = breadcrumbs(model, resolved);

  return (
    <div className="flex flex-col gap-4 p-3">
      <nav className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" aria-label="面包屑">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.label}-${index}`} className="flex items-center gap-1">
            {index > 0 && <ChevronRight className="size-3" />}
            {crumb.target && index < crumbs.length - 1 ? (
              <button type="button" className="hover:text-foreground hover:underline" onClick={() => onSelect(crumb.target!)}>
                {crumb.label}
              </button>
            ) : (
              <span className={index === crumbs.length - 1 ? 'text-foreground' : undefined}>{crumb.label}</span>
            )}
          </span>
        ))}
      </nav>
      <Separator />
      <TargetBody model={model} target={resolved} onSelect={onSelect} />
    </div>
  );
}
