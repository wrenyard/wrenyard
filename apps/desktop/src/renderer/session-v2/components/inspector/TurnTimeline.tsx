import { useMemo, useState } from 'react';
import { TimelineBars, type TimelineBar } from '@/renderer/components/timeline-bars';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
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
  const turn = model.turns.find((candidate) => candidate.id === selected) ?? model.turns[model.turns.length - 1];
  const now = useNow();

  const profile = useMemo(() => (turn ? buildTurnProfile(turn, now) : undefined), [turn, now]);

  if (!turn || !profile) return <p className="p-3 text-sm text-muted-foreground">还没有可用的轮次</p>;

  const handleBar = (bar: TimelineBar): void => {
    const id = bar.id.endsWith('#wait') ? bar.id.slice(0, -'#wait'.length) : bar.id;
    if (turn.actions.some((action) => action.id === id)) onSelect({ kind: 'action', turnId: turn.id, actionId: id });
    else if (turn.calls.some((call) => call.id === id)) onSelect({ kind: 'call', callId: id });
  };

  return (
    <div className="flex flex-col gap-4 p-3">
      <Select value={String(turn.id)} onValueChange={(value) => setSelected(Number(value))}>
        <SelectTrigger size="sm" aria-label="选择轮次">
          <SelectValue>{(value) => `轮次 ${value}`}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {model.turns.map((item) => (
            <SelectItem key={item.id} value={String(item.id)}>{`轮次 ${item.id}`}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <TimelineBars range={profile.range} now={turn.endedAt === undefined ? now : undefined} lanes={profile.lanes} onSelect={handleBar} />

      <div className="overflow-hidden rounded-md border border-border text-xs">
        <table className="w-full">
          <tbody>
            <tr className="border-b border-border">
              <td className="px-2 py-1 text-muted-foreground">墙钟总用时</td>
              <td className="px-2 py-1 text-right font-mono">{formatElapsedMs(profile.summary.wallMs)}</td>
            </tr>
            {profile.summary.phases.map((phase) => (
              <tr key={phase.phase} className="border-b border-border last:border-0">
                <td className="px-2 py-1 text-muted-foreground">{phase.label}总用时</td>
                <td className="px-2 py-1 text-right font-mono">{formatElapsedMs(phase.ms)}</td>
              </tr>
            ))}
            <tr className="border-b border-border">
              <td className="px-2 py-1 text-muted-foreground">推理等待</td>
              <td className="px-2 py-1 text-right font-mono">{formatElapsedMs(profile.summary.reasonWaitMs)}</td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-2 py-1 text-muted-foreground">推理输出</td>
              <td className="px-2 py-1 text-right font-mono">{formatElapsedMs(profile.summary.reasonOutputMs)}</td>
            </tr>
            <tr>
              <td className="px-2 py-1 text-muted-foreground">调用次数</td>
              <td className="px-2 py-1 text-right font-mono">{profile.summary.calls}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
