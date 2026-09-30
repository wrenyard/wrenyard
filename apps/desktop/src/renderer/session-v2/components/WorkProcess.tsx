import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible';
import { Spinner } from '@/renderer/components/ui/spinner';
import { Elapsed } from '@/renderer/components/elapsed';
import { StatusBadge } from '@/renderer/components/status-badge';
import { ShimmerText } from '@/renderer/components/chat/shimmer-text';
import { cn } from '@/renderer/lib/utils';
import { useNow } from '@/renderer/hooks/use-now';
import { buildTurnProfile } from '../model/profile.js';
import { cycleLabel, phaseLabel } from '../model/describe.js';
import type { ActionModel, TurnModel } from '../model/types.js';
import { CycleSteps } from './CycleSteps.js';
import { useInspector } from './inspector/Inspector.js';

function MiniPhaseBarContent({ turn, onOpen, now }: { turn: TurnModel; onOpen: () => void; now: number }) {
  const tones = {
    preparing: 'bg-muted-foreground/40',
    reasoning: 'bg-primary',
    acting: 'bg-[var(--moss)]',
    replying: 'bg-[var(--lamp-deep)]',
  };
  const weights: [string, number, string][] = buildTurnProfile(turn, now).summary.phases
    .map(({ phase, ms }) => [phase, ms, tones[phase]]);
  const total = weights.reduce((sum, [, value]) => sum + value, 0) || 1;
  return (
    <button type="button" onClick={onOpen} aria-label="打开时间线"
      className="flex h-1 w-24 overflow-hidden rounded-full bg-muted">
      {weights.filter(([, value]) => value > 0).map(([phase, value, tone]) => (
        <span key={phase} className={cn('h-full', tone)} style={{ width: `${(value / total) * 100}%` }} />
      ))}
    </button>
  );
}

function RunningMiniPhaseBar({ turn, onOpen }: { turn: TurnModel; onOpen: () => void }) {
  const now = useNow();
  return <MiniPhaseBarContent turn={turn} onOpen={onOpen} now={now} />;
}

function MiniPhaseBar({ turn, onOpen }: { turn: TurnModel; onOpen: () => void }) {
  return turn.endedAt === undefined
    ? <RunningMiniPhaseBar turn={turn} onOpen={onOpen} />
    : <MiniPhaseBarContent turn={turn} onOpen={onOpen} now={Date.parse(turn.endedAt)} />;
}

function ActionTag({ action }: { action: ActionModel }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
      <span className="truncate max-w-32">{action.title}</span>
      <span className="shrink-0"><Elapsed start={action.startedAt} end={action.endedAt} /></span>
    </span>
  );
}

function RunningSummary({ turn }: { turn: TurnModel }) {
  const lastProgress = turn.progress[turn.progress.length - 1];
  const currentCycle = turn.cycles[turn.cycles.length - 1];
  const reasonCall = turn.calls.find((call) => call.id === currentCycle?.reasoning?.callId);
  const reasoningStart = Date.parse(reasonCall?.startedAt ?? currentCycle?.startedAt ?? turn.startedAt);
  const useProgress = lastProgress !== undefined && Date.parse(lastProgress.at) >= reasoningStart;
  const text = useProgress
    ? lastProgress!.text
    : currentCycle?.reasoning?.text.split('\n').slice(-2).join('\n') ?? '';

  const runningActions = turn.actions.filter((action) => action.status === 'running');
  const shown = runningActions.slice(0, 3);
  const overflow = runningActions.length - shown.length;

  return (
    <div className="flex flex-col gap-1.5 pb-1">
      {text !== '' && (
        <p key={text} className="animate-in fade-in slide-in-from-bottom-1 text-xs text-muted-foreground line-clamp-2">
          {text}
        </p>
      )}
      {shown.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {shown.map((action) => <ActionTag key={action.id} action={action} />)}
          {overflow > 0 && <span className="text-xs text-muted-foreground">+{overflow}</span>}
        </div>
      )}
    </div>
  );
}

export interface WorkProcessProps {
  turn: TurnModel;
}

/** Collapsed-by-default work process with a persistent status header. */
export function WorkProcess({ turn }: WorkProcessProps) {
  const [open, setOpen] = useState(false);
  const { inspectTimeline } = useInspector();
  const running = turn.status === 'running';

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border/70 bg-card/40">
      <div className="flex w-full items-center gap-2 px-2.5 py-2">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {running ? <Spinner className="size-3.5 text-primary" /> : <StatusBadge status={turn.status} label="" />}
          {running ? (
            <>
              <ShimmerText className="text-sm font-medium">{phaseLabel(turn.phase ?? 'preparing')}</ShimmerText>
              <span className="text-xs text-muted-foreground">{cycleLabel(Math.max(1, turn.cycle))}</span>
              <span className="text-xs text-muted-foreground"><Elapsed start={turn.startedAt} end={turn.endedAt} /></span>
            </>
          ) : (
            <>
              <span className="text-sm">打造了 <Elapsed start={turn.startedAt} end={turn.endedAt} /></span>
              {turn.status !== 'completed' && <StatusBadge status={turn.status} />}
            </>
          )}
          <ChevronDown className={cn('ml-auto size-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </CollapsibleTrigger>
        <MiniPhaseBar turn={turn} onOpen={() => inspectTimeline?.({ kind: 'turn', turnId: turn.id })} />
      </div>
      {running && !open && (
        <div className="px-2.5 pb-2">
          <RunningSummary turn={turn} />
        </div>
      )}
      <CollapsibleContent>
        <div className="border-t border-border/70 px-2.5 py-2">
          {open && <CycleSteps turn={turn} />}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
