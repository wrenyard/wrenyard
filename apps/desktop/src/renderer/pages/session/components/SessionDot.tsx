/**
 * Fixed-width leading slot for a session row. It always renders the slot so
 * titles align regardless of status; a non-idle status adds an 8px dot with a
 * hover tooltip. The tooltip trigger is a span so it never nests a button
 * inside the row's own button.
 */
import { cn } from 'cn';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import type { SessionStatus, SessionStatusKind } from '../model/session-status';

/** The 8px dot's colour and motion per status; `working` keeps the pulse. */
const DOT_CLASS: Record<Exclude<SessionStatusKind, 'idle'>, string> = {
  working: 'border-[1.5px] border-current text-primary motion-session-dot',
  attention: 'bg-[var(--status-attention)]',
  error: 'bg-destructive',
  unread: 'bg-[var(--status-unread)]',
};

export function SessionDot({ status }: { status: SessionStatus }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {status.kind !== 'idle' && (
        <Tooltip>
          <TooltipTrigger
            render={<span role="status" aria-label={status.tooltip} className={cn('size-2 rounded-full', DOT_CLASS[status.kind])} />}
          />
          <TooltipContent>{status.tooltip}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
