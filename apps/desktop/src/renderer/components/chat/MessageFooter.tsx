import type { ReactNode } from 'react';
import { cn } from 'cn';
import { CopyButton } from '@/renderer/components/copy-button';
import { formatClock, formatDateTime } from '@/renderer/lib/format';

export interface MessageFooterProps {
  /** `right` for the user's own messages, `left` for replies. */
  align?: 'left' | 'right';
  /** ISO stamp shown as `HH:mm`; the full local date-time lives in its title. */
  at?: string;
  /** Text the copy button copies; omitted when there is nothing to copy. */
  text?: string;
  /** Display name of the model that wrote a reply. */
  model?: string;
  /** Accessible label of the copy button. */
  copyLabel?: string;
  className?: string;
  /** Always-visible extras (dispatch terminal label, running tasks, send states). */
  children?: ReactNode;
}

/**
 * One message's metadata row. Its height is reserved at all times; only the
 * copy/time/model cluster fades, and only while the owning `group/msg` message
 * is hovered or holds focus. Extras passed as children stay visible and lead
 * the row, ahead of the fading cluster.
 */
export function MessageFooter({
  align = 'left',
  at,
  text,
  model,
  copyLabel = '复制',
  className,
  children,
}: MessageFooterProps) {
  const copy = text === undefined || text.trim() === ''
    ? null
    : <CopyButton text={text} label={copyLabel} size="icon-xs" className="-my-1" />;
  const time = at === undefined ? null : (
    <time dateTime={at} title={formatDateTime(at)}>{formatClock(at)}</time>
  );
  const metadata = align === 'right'
    ? <>{time}{copy}</>
    : <>{copy}{time}{model !== undefined && <span className="truncate">{model}</span>}</>;
  return (
    <div
      className={cn(
        'flex h-6 min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums',
        align === 'right' ? 'justify-end' : 'justify-start',
        className,
      )}
    >
      {children}
      <span className="inline-flex min-w-0 items-center gap-1.5 opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100">
        {metadata}
      </span>
    </div>
  );
}
