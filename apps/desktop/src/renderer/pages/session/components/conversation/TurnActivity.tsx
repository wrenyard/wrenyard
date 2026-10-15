import { Square } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Spinner } from '@/renderer/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { CALL_ROLE_LABEL, turnStatusText } from '../../model/describe.js';
import type { CallModel, TurnModel } from '../../model/types.js';

/** Returns the currently running auxiliary calls for a turn. */
export function runningAuxCalls(turn: TurnModel): CallModel[] {
  return turn.calls.filter((call) => call.status === 'running' && call.role !== 'reason');
}

/** Props for the per-turn interrupt control. */
export interface InterruptButtonProps {
  turn: TurnModel;
  onInterrupt: (turn: number) => void;
  className?: string;
}

/** Renders a control to interrupt one running turn. */
export function InterruptButton({ turn, onInterrupt, className }: InterruptButtonProps) {
  if (turn.status !== 'running') return null;
  const interrupting = turn.interrupting;
  const label = interrupting ? '正在中断…' : '中断此轮次';
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            variant="ghost"
            size="icon-sm"
            className={className}
            aria-label={label}
            disabled={interrupting}
            onClick={() => onInterrupt(turn.id)}
          />
        )}
      >
        {interrupting ? <Spinner /> : <Square className="fill-current" />}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Shows the live phase, running auxiliary calls, and interrupt control for a turn. */
export function TurnActivity({ turn, onInterrupt }: { turn: TurnModel; onInterrupt: (turn: number) => void }) {
  if (turn.status !== 'running') return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 pl-1 text-sm text-muted-foreground">
      <Spinner className="size-3.5" />
      <span className="shimmer">{turnStatusText(turn)}</span>
      {runningAuxCalls(turn).map((call) => (
        <span
          key={call.id}
          className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-xs text-foreground animate-in fade-in-0 zoom-in-95 duration-200"
        >
          <span className="motion-pulse-slow size-1.5 rounded-full bg-primary" />
          {CALL_ROLE_LABEL[call.role] ?? call.role}
        </span>
      ))}
      <InterruptButton turn={turn} onInterrupt={onInterrupt} />
    </div>
  );
}
