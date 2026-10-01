import { PanelRight } from 'lucide-react';
import { SourceDevelopmentBadge } from '@/renderer/components/source-development-badge';
import { Badge } from '@/renderer/components/ui/badge';
import { Button } from '@/renderer/components/ui/button';
import { SidebarTrigger } from '@/renderer/components/ui/sidebar';
import { Spinner } from '@/renderer/components/ui/spinner';
import type { SessionModel, SessionSummary } from '../model/types.js';
import { SessionTitle } from './SessionTitle.js';

export interface SessionTopBarProps {
  title: string;
  session?: SessionSummary;
  snapshot: SessionModel['snapshot'];
  turnCount: number;
  draft: boolean;
  runningTurns: number;
  inspectorOpen: boolean;
  onToggleInspector(): void;
}

/** Floating three-column top bar: sidebar toggle, centred title, inspector toggle. */
export function SessionTopBar({
  title,
  session,
  snapshot,
  turnCount,
  draft,
  runningTurns,
  inspectorOpen,
  onToggleInspector,
}: SessionTopBarProps) {
  return (
    <header className="absolute inset-x-0 top-0 z-10 grid h-(--header-height) grid-cols-[1fr_auto_1fr] items-center px-4">
      <div className="flex items-center gap-2">
        <SidebarTrigger />
        <SourceDevelopmentBadge />
      </div>
      <div className="flex justify-center">
        <SessionTitle title={title} session={session} snapshot={snapshot} turnCount={turnCount} draft={draft} />
      </div>
      <div className="flex items-center justify-end gap-2">
        {runningTurns > 0 && (
          <Badge variant="secondary"><Spinner />{runningTurns}</Badge>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="检查器"
          aria-pressed={inspectorOpen}
          onClick={onToggleInspector}
        >
          <PanelRight />
        </Button>
      </div>
    </header>
  );
}
