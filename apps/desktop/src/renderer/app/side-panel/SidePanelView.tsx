import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { closeSidePanel } from '@/renderer/lib/side-panel';

export function SidePanelView({ title, children }: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-12 items-center justify-between gap-2 px-4">
        <span className="text-sm font-medium">{title}</span>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button variant="ghost" size="icon-sm" aria-label="关闭" onClick={closeSidePanel} />
              )}
            >
              <X />
            </TooltipTrigger>
            <TooltipContent>关闭</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}
