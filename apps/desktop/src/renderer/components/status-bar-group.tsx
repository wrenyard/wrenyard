import { Fragment } from 'react';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';

/**
 * VS Code style connected status-bar button group (window-chrome spec 4.1).
 * One `flex items-stretch` container holds button-like segments separated by a
 * 1px `bg-border` divider; each segment highlights on hover on its own and may
 * carry its own dark tooltip. It takes generic props only — no session types —
 * so any page can publish a connected multi-segment item. The `h-5 / px-1.5 /
 * text-xs` sizing and the 14px (`size-3.5`) icon are the registered status-bar
 * exception from the architecture spec (section 7), matching
 * {@link StatusBarButton}; tone comes from theme tokens only.
 */
export interface StatusBarSegment {
  /** Stable identity for React and the divider key. */
  key: string;
  icon?: LucideIcon;
  /** Extra classes applied to the segment icon (e.g. a state colour). */
  iconClassName?: string;
  label: ReactNode;
  ariaLabel?: string;
  onClick?: () => void;
  /** Per-segment dark tooltip; omitted when the segment shows no extra detail. */
  tooltip?: ReactNode;
}

export interface StatusBarGroupProps {
  segments: readonly StatusBarSegment[];
  /** Accessible name of the whole connected group. */
  ariaLabel?: string;
  className?: string;
}

export function StatusBarGroup({ segments, ariaLabel, className }: StatusBarGroupProps) {
  return (
    <div
      className={cn('flex shrink-0 items-stretch', className)}
      aria-label={ariaLabel}
      data-slot="status-bar-group"
    >
      {segments.map((segment, index) => {
        const Icon = segment.icon;
        const button = (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={segment.ariaLabel}
            onClick={segment.onClick}
            className="h-5 shrink-0 gap-1 rounded-none px-1.5 text-xs text-muted-foreground whitespace-nowrap"
          >
            {Icon ? <Icon className={cn('size-3.5 shrink-0', segment.iconClassName)} /> : null}
            <span className="truncate tabular-nums">{segment.label}</span>
          </Button>
        );
        return (
          <Fragment key={segment.key}>
            {index > 0 && (
              <span className="h-3 w-px shrink-0 self-center bg-border" aria-hidden="true" />
            )}
            {segment.tooltip === undefined ? button : (
              <Tooltip>
                <TooltipTrigger render={button} />
                <TooltipContent>{segment.tooltip}</TooltipContent>
              </Tooltip>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
