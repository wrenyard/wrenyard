import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';

/**
 * One status-bar item button (window-chrome spec 4.1): the official `Button`
 * with `variant="ghost"` and `size="xs"`, carrying an optional 14px lucide icon
 * and a short text label, muted unless the item is in an alert state. The
 * `h-5 px-1.5 text-xs` height/padding and the 14px (`size-3.5`) icon are the
 * registered status-bar exception from the architecture spec (section 7). The
 * component forwards the trigger ref so it can be used as a composable
 * tooltip/popover trigger.
 */
export type StatusBarTone = 'default' | 'warning' | 'destructive';

const TONE_CLASS: Record<Exclude<StatusBarTone, 'default'>, string> = {
  warning: 'text-warning',
  destructive: 'text-destructive',
};

export interface StatusBarButtonProps
  extends Omit<ComponentProps<typeof Button>, 'variant' | 'size' | 'children'> {
  icon?: LucideIcon;
  label?: ReactNode;
  /** Hover tooltip; omitted when there is nothing more to show. */
  tooltip?: string;
  tone?: StatusBarTone;
  ariaLabel?: string;
  children?: ReactNode;
}

export function StatusBarButton({
  icon: Icon,
  label,
  tooltip,
  tone = 'default',
  ariaLabel,
  className,
  children,
  ...props
}: StatusBarButtonProps) {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      data-slot="status-bar-button"
      aria-label={ariaLabel}
      className={cn(
        'h-5 shrink-0 gap-1 px-1.5 text-xs whitespace-nowrap',
        tone === 'default' ? 'text-muted-foreground' : TONE_CLASS[tone],
        className,
      )}
      {...props}
    >
      {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
      {label !== undefined ? <span className="truncate tabular-nums">{label}</span> : null}
      {children}
    </Button>
  );

  if (tooltip === undefined) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
