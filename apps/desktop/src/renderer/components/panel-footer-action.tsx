import type { ReactNode } from 'react';
import { ArrowUpRight, type LucideIcon } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';

/**
 * Generic footer action for a popover/panel (window-chrome spec 4.5): a full
 * width outline button with a trailing icon, wrapped in a small padded row so
 * it sits below a `Separator`. Presentational only — no session or quota types
 * — so every panel footer shares one button style.
 */
export interface PanelFooterActionProps {
  label: ReactNode;
  onClick: () => void;
  /** Trailing icon; defaults to a jump-out affordance. */
  icon?: LucideIcon;
}

export function PanelFooterAction({ label, onClick, icon: Icon = ArrowUpRight }: PanelFooterActionProps) {
  return (
    <div className="p-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full justify-center gap-1.5"
        onClick={onClick}
      >
        {label}
        <Icon className="size-3.5" />
      </Button>
    </div>
  );
}
