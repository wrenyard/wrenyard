/**
 * Fixed-width leading slot for a session row. It always renders the slot so
 * titles align regardless of status: `working` keeps its pulsing ring and
 * `idle` shows a muted 8px hollow ring, while `attention`, `error` and `unread` each
 * use their own 16px icon in the state's existing colour. Every glyph carries
 * a hover tooltip; the tooltip trigger is a span so it never nests a button
 * inside the row's own button.
 */
import { CircleCheck, CircleX, MessageCircleQuestion, type LucideIcon } from 'lucide-react';
import { cn } from 'cn';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import type { SessionStatus, SessionStatusKind } from '../model/session-status';

/** The two states that stay 8px dots; `working` keeps the pulse. */
const DOT_CLASS: Record<'working' | 'idle', string> = {
  working: 'border-[1.5px] border-current text-primary motion-session-dot',
  idle: 'border-[1.5px] border-muted-foreground',
};

/** Every other state gets a 16px icon in its existing status colour. */
const ICONS: Record<Exclude<SessionStatusKind, 'working' | 'idle'>, { Icon: LucideIcon; className: string }> = {
  attention: { Icon: MessageCircleQuestion, className: 'text-[var(--status-attention)]' },
  error: { Icon: CircleX, className: 'text-destructive' },
  unread: { Icon: CircleCheck, className: 'text-[var(--status-unread)]' },
};

/** `idle` has no tooltip text of its own, so it falls back to this label. */
const IDLE_LABEL = '空闲';

export function SessionDot({ status }: { status: SessionStatus }) {
  const label = status.tooltip ?? IDLE_LABEL;
  const icon = status.kind === 'attention' || status.kind === 'error' || status.kind === 'unread'
    ? ICONS[status.kind]
    : null;
  const dotClass = status.kind === 'working' || status.kind === 'idle' ? DOT_CLASS[status.kind] : undefined;

  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <span role="status" aria-label={label} className="flex size-4 items-center justify-center">
              {icon ? (
                <icon.Icon aria-hidden="true" className={cn('size-4', icon.className)} />
              ) : (
                <span className={cn('size-2 rounded-full', dotClass)} />
              )}
            </span>
          }
        />
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </span>
  );
}
