import { useEffect, useMemo, useState } from 'react';
import { TimelineBars, type TimelineBar } from '@/renderer/components/timeline-bars';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { Table, TableBody, TableCell, TableRow } from '@/renderer/components/ui/table';
import { useNow } from '@/renderer/hooks/use-now';
import { formatElapsedMs } from '@/renderer/lib/format';
import { buildTurnProfile } from '../../model/profile.js';
import type { InspectorTarget, SessionModel } from '../../model/types.js';

export interface TurnTimelineProps {
  model: SessionModel;
  target: InspectorTarget | undefined;
  onSelect: (target: InspectorTarget) => void;
}

/** Turn profiler: phase, call and action lanes plus a summary table. */
export function TurnTimeline({ model, target, onSelect }: TurnTimelineProps) {
  const targetTurn = target && 'turnId' in target ? target.turnId : undefined;
  const latest = model.turns[model.turns.length - 1]?.id;
  const [selected, setSelected] = useState<number>(targetTurn ?? latest ?? 0);
  useEffect(() => {
    if (targetTurn !== undefined) setSelected(targetTurn);
  }, [targetTurn]);
  const turn = model.turns.find((candidate) => candidate.id === selected) ?? model.turns[model.turns.length - 1];
  const now = useNow();

  const profile = useMemo(() => (turn ? buildTurnProfile(turn, now) : undefined), [turn, now]);

  if (!turn || !profile) return <p className="text-sm text-muted-foreground">还没有可用的轮次</p>;

  const handleBar = (bar: TimelineBar): void => {
    const id = bar.id.endsWith('#wait') ? bar.id.slice(0, -'#wait'.length) : bar.id;
    if (turn.actions.some((action) => action.id === id)) onSelect({ kind: 'action', turnId: turn.id, actionId: id });
    else if (turn.calls.some((call) => call.id === id)) onSelect({ kind: 'call', callId: id });
  };

  return (
    <div className="flex flex-col gap-4">
      <Select value={String(turn.id)} onValueChange={(value) => setSelected(Number(value))}>
        <SelectTrigger aria-label="选择轮次">
          <SelectValue>{(value) => `轮次 ${value}`}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {model.turns.map((item) => (
            <SelectItem key={item.id} value={String(item.id)}>{`轮次 ${item.id}`}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <TimelineBars range={profile.range} now={turn.endedAt === undefined ? now : undefined} lanes={profile.lanes} onSelect={handleBar} />

      <Table>
        <TableBody>
          <TableRow>
            <TableCell>墙钟总用时</TableCell>
            <TableCell className="text-right tabular-nums">{formatElapsedMs(profile.summary.wallMs)}</TableCell>
          </TableRow>
          {profile.summary.phases.map((phase) => (
            <TableRow key={phase.phase}>
              <TableCell>{phase.label}总用时</TableCell>
              <TableCell className="text-right tabular-nums">{formatElapsedMs(phase.ms)}</TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell>推理等待</TableCell>
            <TableCell className="text-right tabular-nums">{formatElapsedMs(profile.summary.reasonWaitMs)}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>推理输出</TableCell>
            <TableCell className="text-right tabular-nums">{formatElapsedMs(profile.summary.reasonOutputMs)}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>调用次数</TableCell>
            <TableCell className="text-right tabular-nums">{profile.summary.calls}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
