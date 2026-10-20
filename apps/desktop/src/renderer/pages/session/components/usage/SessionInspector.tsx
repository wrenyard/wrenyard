import { useEffect, useRef, useState } from 'react';
import { PanelRight } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { TitleBarAuxiliary } from '@/renderer/components/page';
import { UsageCard } from '@/renderer/components/usage/UsageCard';
import { QuotaCardActions, QuotaPanel } from '@/renderer/app/statusbar/QuotaPanel';
import { useQuotaFocus } from '@/renderer/lib/quota-focus';
import {
  closeSessionInspector,
  consumeSessionInspectorProvider,
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

function SessionInspectorUsageBody() {
  const { turns } = useSessionUsage();
  const data = useSessionUsagePanelData({ turns });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const note = taskNoteOf(data.runningTasks, data.missingTasks);

  return (
    <div className="flex flex-col gap-3" data-slot="usage-session-section">
      <UsageCard id="context" title="上下文">
        <ContextBreakdown
          roles={data.roles}
          budget={data.budget}
          groups={data.groups}
          modelName={data.models.find((entry) => entry.publicId === data.modelId)?.displayName}
        />
      </UsageCard>
      <UsageCard id="session" title="本会话用量">
        <SessionUsagePanel
          clusters={data.clusters}
          groups={{ reason: data.callGroups.reason, aux: data.callGroups.aux, task: data.taskGroups }}
          note={note}
          rootRef={panelRef}
          currency={data.currency}
        />
      </UsageCard>
    </div>
  );
}

export function SessionInspector({ draft }: { draft: boolean }) {
  const { open } = useSessionInspectorState();
  const focus = useQuotaFocus();
  const asideRef = useRef<HTMLElement | null>(null);
  const [rowWidth, setRowWidth] = useState(0);
  const [scrollTarget, setScrollTarget] = useState<string | undefined>(undefined);

  useEffect(() => {
    setScrollTarget(consumeSessionInspectorProvider());
  }, [open]);

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
          className="absolute inset-0 z-30 bg-black/20"
          onMouseDown={() => closeSessionInspector()}
        />
      ) : null}
      <aside
        ref={asideRef}
        className={cn(
          'flex w-80 min-h-0 shrink-0 flex-col border-l bg-background',
          overlay && 'absolute inset-y-0 right-0 z-40 shadow-lg',
        )}
        data-slot="session-inspector"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          {draft ? null : <SessionInspectorUsageBody />}
          <UsageCard
            id="quota"
            title="额度"
            actions={<QuotaCardActions />}
          >
            <QuotaPanel firstProviderId={focus ?? undefined} scrollProviderId={scrollTarget} />
          </UsageCard>
        </div>
      </aside>
    </>
  );
}
