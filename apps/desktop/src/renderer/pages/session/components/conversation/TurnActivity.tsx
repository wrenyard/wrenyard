import { Square } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Elapsed } from '@/renderer/components/elapsed';
import { Spinner } from '@/renderer/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { CALL_ROLE_LABEL, TASK_RUN_PHASE_LABEL, runningTaskAction, turnStatusText, waitingStatusText, type TurnWaitingState } from '../../model/describe.js';
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

/** Props for the live turn activity line. */
export interface TurnActivityProps {
  turn: TurnModel;
  onInterrupt: (turn: number) => void;
  /**
   * The turn's current recovery waiting state, from its `turn.waiting` event.
   * Present while the turn waits for permission to probe or for a guaranteed
   * recovery, including a wait with no known recovery time; omitted on the next
   * upstream attempt, at completion or after a cancel, which clears the waiting
   * display.
   */
  waiting?: TurnWaitingState;
}

/**
 * Shows the live phase, running auxiliary calls and the interrupt control for
 * a turn. While the turn is waiting for recovery it shows that distinct
 * nonterminal status instead, with the interrupt control still available.
 */
export function TurnActivity({ turn, onInterrupt, waiting }: TurnActivityProps) {
  if (turn.status !== 'running') return null;
  // Waiting for recovery replaces the generating/reasoning status and the
  // auxiliary chips; it is never presented as generating and stays interruptible.
  if (waiting !== undefined) {
    return (
      <div role="status" className="flex flex-wrap items-center gap-2 pl-1 text-sm text-muted-foreground">
        <Spinner className="size-3.5" />
        <span className="shimmer">{waitingStatusText(waiting)}</span>
        <InterruptButton turn={turn} onInterrupt={onInterrupt} />
      </div>
    );
  }
  // The implementation phase is timed from the task run it opened, separate
  // from the compile call's own duration; it is never shown as compiling.
  const taskRun = runningTaskAction(turn);
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 pl-1 text-sm text-muted-foreground">
      <Spinner className="size-3.5" />
      <span className="shimmer">{taskRun === undefined ? turnStatusText(turn) : `${TASK_RUN_PHASE_LABEL}…`}</span>
      {taskRun !== undefined && <Elapsed start={taskRun.startedAt} className="tabular-nums" />}
      {runningAuxCalls(turn).map((call) => (
        <span
          key={call.id}
          className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-xs text-foreground animate-in fade-in-0 zoom-in-95 duration-base"
        >
          <span className="motion-pulse-slow size-1.5 rounded-full bg-primary" />
          {CALL_ROLE_LABEL[call.role] ?? call.role}
        </span>
      ))}
      <InterruptButton turn={turn} onInterrupt={onInterrupt} />
    </div>
  );
}
