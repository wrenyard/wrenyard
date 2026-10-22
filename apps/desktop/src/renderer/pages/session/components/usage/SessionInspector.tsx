import { useEffect, useRef, useState } from 'react';
import { ChartColumn, PanelRight } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { TitleBarAuxiliary } from '@/renderer/components/page';
import { UsageCard, UsageCardSkeletonBody } from '@/renderer/components/usage/UsageCard';
import { QuotaCardActions, QuotaPanel } from '@/renderer/app/statusbar/QuotaPanel';
import { shell } from '@/renderer/lib/desktop';
import { useQuotaFocus } from '@/renderer/lib/quota-focus';
import {
  closeSessionInspector,
  toggleSessionInspector,
  useSessionInspectorState,
} from '@/renderer/lib/session-inspector';
import { useSessionUsage } from '../../state/session-usage';
import { useSessionUsagePanelData } from './useSessionUsagePanelData';
import { ContextBreakdown } from './ContextBreakdown';
import { SessionUsagePanel, taskNoteOf } from './SessionUsagePanel';

const NARROW_ROW_MAX = 760;

export function SessionInspectorToggle() {
  const { open } = useSessionInspectorState();

  return (
    <TitleBarAuxiliary>
      <Tooltip>
        <TooltipTrigger
          render={(
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="会话详情"
              aria-pressed={open}
              className={cn(open && 'bg-muted')}
              onClick={() => toggleSessionInspector()}
            />
          )}
        >
          <PanelRight />
        </TooltipTrigger>
        <TooltipContent>会话详情</TooltipContent>
      </Tooltip>
    </TitleBarAuxiliary>
  );
}

function SessionInspectorUsageBody({ hydrating }: { hydrating: boolean }) {
  const { turns } = useSessionUsage();
  const data = useSessionUsagePanelData({ turns });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const note = taskNoteOf(data.runningTasks, data.missingTasks);

  return (
    <div className="flex flex-col gap-2.5" data-slot="usage-session-section">
      <UsageCard id="context" title="上下文">
        {hydrating ? (
          <UsageCardSkeletonBody />
        ) : (
          <ContextBreakdown
            roles={data.roles}
            budget={data.budget}
            groups={data.groups}
            modelName={data.models.find((entry) => entry.publicId === data.modelId)?.displayName}
          />
        )}
      </UsageCard>
      <UsageCard
        id="session"
        title="用量"
        footer={(
          <>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{note ?? ''}</span>
            <Button variant="outline" size="xs" onClick={() => void shell.navigate('stats')}>
              <ChartColumn />
              工房台账
            </Button>
          </>
        )}
      >
        {hydrating ? (
          <UsageCardSkeletonBody />
        ) : (
          <SessionUsagePanel
            clusters={data.clusters}
            groups={{ reason: data.callGroups.reason, aux: data.callGroups.aux, task: data.taskGroups }}
            rootRef={panelRef}
            currency={data.currency}
          />
        )}
      </UsageCard>
    </div>
  );
}

export function SessionInspector({ draft, usageHydrating = false }: { draft: boolean; usageHydrating?: boolean }) {
  const { open } = useSessionInspectorState();
  const focus = useQuotaFocus();
  const asideRef = useRef<HTMLElement | null>(null);
  const [rowWidth, setRowWidth] = useState(0);

  useEffect(() => {
    if (!open) return;
    const parent = asideRef.current?.parentElement;
    if (parent === null || parent === undefined) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? parent.clientWidth;
      setRowWidth(width);
    });
    observer.observe(parent);
    setRowWidth(parent.clientWidth);
    return () => observer.disconnect();
  }, [open]);

  if (!open) return null;

  const overlay = rowWidth > 0 && rowWidth < NARROW_ROW_MAX;

  return (
    <>
      {overlay ? (
        <div
          className="absolute inset-0 z-30 bg-(--overlay)"
          onMouseDown={() => closeSessionInspector()}
        />
      ) : null}
      <aside
        ref={asideRef}
        className={cn(
          'absolute inset-y-0 right-(--session-scrollbar) w-80 flex min-h-0 flex-col bg-background',
          // The border and shadow belong to the narrow overlay only: in flow
          // the panel floats over the transcript's scrollbar-gutter space.
          overlay && 'right-0 z-40 border-l shadow-lg',
        )}
        data-slot="session-inspector"
      >
        <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2.5 pt-[calc(0.625rem+var(--session-top-fade))]">
          {draft ? null : <SessionInspectorUsageBody hydrating={usageHydrating} />}
          <UsageCard
            id="quota"
            title="额度"
            actions={<QuotaCardActions />}
          >
            <QuotaPanel providerId={focus ?? undefined} />
          </UsageCard>
        </div>
      </aside>
    </>
  );
}
