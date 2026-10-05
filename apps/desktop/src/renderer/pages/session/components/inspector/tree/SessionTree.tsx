import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildSessionTree } from '../../../model/fold.js';
import type { LedgerEvent, TurnNode } from '../../../model/types.js';
import { TreeExpansionContext, type TreeExpansion } from './expansion.js';
import { TurnRow } from './TurnRow.js';
import { actionAnchorId, actionNodeId, cycleNodeId, phaseNodeId, turnNodeId } from './ids.js';

function startOf(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** Turn numbers whose [start, end) range overlaps another turn's range. */
function overlappingTurns(turns: readonly TurnNode[]): Set<number> {
  const ranges = turns.map((turn) => ({
    id: turn.turn,
    start: startOf(turn.startedAt),
    end: turn.endedAt === undefined ? Number.POSITIVE_INFINITY : startOf(turn.endedAt),
  }));
  const result = new Set<number>();
  for (let i = 0; i < ranges.length; i += 1) {
    for (let j = i + 1; j < ranges.length; j += 1) {
      const a = ranges[i]!;
      const b = ranges[j]!;
      if (Number.isNaN(a.start) || Number.isNaN(b.start)) continue;
      if (a.start < b.end && b.start < a.end) {
        result.add(a.id);
        result.add(b.id);
      }
    }
  }
  return result;
}

export interface SessionTreeProps {
  events: readonly LedgerEvent[];
}

/**
 * Collapsible tree over the whole session: every turn, its reasoning cycles and
 * the 准备 / 推理 / 行动 phases. Expansion is per node and survives new events.
 */
export function SessionTree({ events }: SessionTreeProps) {
  const turns = useMemo(() => buildSessionTree(events), [events]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [scrollTo, setScrollTo] = useState<string | undefined>(undefined);
  const seeded = useRef(false);

  // Open the newest turn and its newest cycle once, then never reseed while the
  // session stays mounted (the component is keyed by session in the inspector).
  useEffect(() => {
    if (seeded.current || turns.length === 0) return;
    seeded.current = true;
    const newest = turns[turns.length - 1]!;
    const ids = new Set<string>([turnNodeId(newest.turn)]);
    const newestCycle = newest.cycles[newest.cycles.length - 1];
    if (newestCycle) ids.add(cycleNodeId(newest.turn, newestCycle.cycle));
    setOpen(ids);
  }, [turns]);

  const isOpen = useCallback((id: string) => open.has(id), [open]);
  const toggle = useCallback((id: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const jumpToAction = useCallback((turn: number, cycle: number, actionId: string) => {
    setOpen((current) => {
      const next = new Set(current);
      next.add(turnNodeId(turn));
      next.add(cycleNodeId(turn, cycle));
      next.add(phaseNodeId(turn, cycle, 'act'));
      next.add(actionNodeId(actionId));
      return next;
    });
    setScrollTo(actionId);
  }, []);

  useEffect(() => {
    if (scrollTo === undefined) return;
    document.getElementById(actionAnchorId(scrollTo))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setScrollTo(undefined);
  }, [scrollTo]);

  const value = useMemo<TreeExpansion>(() => ({ isOpen, toggle, jumpToAction }), [isOpen, toggle, jumpToAction]);

  if (turns.length === 0) {
    return <p className="text-sm text-muted-foreground">还没有可用的轮次</p>;
  }

  const parallel = overlappingTurns(turns);

  return (
    <TreeExpansionContext.Provider value={value}>
      <div className="flex flex-col">
        {turns.map((turn) => (
          <TurnRow key={turn.turn} turn={turn} parallel={parallel.has(turn.turn)} />
        ))}
      </div>
    </TreeExpansionContext.Provider>
  );
}
