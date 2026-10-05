import { ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { Elapsed } from '@/renderer/components/elapsed';
import { StatusBadge } from '@/renderer/components/status-badge';
import { cn } from 'cn';
import { cycleLabel, statusView } from '../../../model/describe.js';
import type { CycleNode, TurnNode } from '../../../model/types.js';
import { PhaseRows } from './PhaseRows.js';
import { TREE_CHILDREN, cycleNodeId, turnNodeId } from './ids.js';
import { useTreeExpansion } from './expansion.js';

function CycleRow({ turn, cycle }: { turn: number; cycle: CycleNode }) {
  const { isOpen, toggle } = useTreeExpansion();
  const nodeId = cycleNodeId(turn, cycle.cycle);
  const open = isOpen(nodeId);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => toggle(nodeId)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors hover:bg-muted/60"
      >
        {open
          ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className={cn('shrink-0', cycle.running && 'shimmer')}>{cycleLabel(cycle.cycle)}</span>
        <span className="min-w-0 flex-1" />
        {cycle.running && <StatusBadge tone="running" label="" className="shrink-0" />}
        <Elapsed start={cycle.startedAt ?? ''} end={cycle.endedAt} className="shrink-0 text-xs text-muted-foreground" />
      </button>
      {open && <div className={TREE_CHILDREN}><PhaseRows turn={turn} cycle={cycle} /></div>}
    </div>
  );
}

export interface TurnRowProps {
  turn: TurnNode;
  /** Another turn's time range overlaps this one. */
  parallel: boolean;
}

/** One compact turn row; expands to its reasoning cycles. */
export function TurnRow({ turn, parallel }: TurnRowProps) {
  const { isOpen, toggle } = useTreeExpansion();
  const nodeId = turnNodeId(turn.turn);
  const open = isOpen(nodeId);
  const status = statusView(turn.status);
  const firstLine = (turn.userText.split('\n', 1)[0] ?? '').trim();
  const summary = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        title={summary}
        onClick={() => toggle(nodeId)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60"
      >
        {parallel && <Layers className="size-3.5 shrink-0 text-warning" aria-label="与其他轮次并行" role="img" />}
        {open
          ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="shrink-0 font-medium">轮次 {turn.turn}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>
        <StatusBadge tone={status.tone} label={status.label} className="shrink-0" />
        <Elapsed start={turn.startedAt} end={turn.endedAt} className="shrink-0 text-xs text-muted-foreground" />
      </button>
      {open && (
        <div className={TREE_CHILDREN}>
          {turn.cycles.length === 0
            ? <p className="px-2 py-1 text-xs text-muted-foreground">还没有推理</p>
            : turn.cycles.map((cycle) => <CycleRow key={cycle.cycle} turn={turn.turn} cycle={cycle} />)}
        </div>
      )}
    </div>
  );
}
