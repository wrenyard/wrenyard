import { PanelRight, X } from 'lucide-react';
import { Alert, AlertAction, AlertDescription } from '@/renderer/components/ui/alert';
import { Badge } from '@/renderer/components/ui/badge';
import { Button } from '@/renderer/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/renderer/components/ui/hover-card';
import { Spinner } from '@/renderer/components/ui/spinner';
import { formatSnapshotStamp } from '@/renderer/lib/format';
import type { SessionModel } from '../model/types.js';

export interface SessionHeaderProps {
  title: string;
  snapshot: SessionModel['snapshot'];
  runningTurns: number;
  inspectorOpen: boolean;
  error: string;
  onToggleInspector(): void;
  onDismissError(): void;
}

/** Session title, snapshot summary, running count and the inspector toggle. */
export function SessionHeader({ title, snapshot, runningTurns, inspectorOpen, error, onToggleInspector, onDismissError }: SessionHeaderProps) {
  return (
    <header className="flex flex-col border-b border-border">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          {snapshot && (
            <HoverCard>
              <HoverCardTrigger render={<button type="button" className="text-xs text-muted-foreground hover:underline" />}>
                {`快照 ${formatSnapshotStamp(snapshot.takenAt)} · ${snapshot.projects.length} 个项目`}
              </HoverCardTrigger>
              <HoverCardContent className="w-72">
                <div className="flex flex-col gap-1 text-xs">
                  {snapshot.projects.length === 0 && <span className="text-muted-foreground">没有登记的项目</span>}
                  {snapshot.projects.map((project) => (
                    <div key={project.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{project.displayName ?? project.id}</span>
                      <span className="shrink-0 font-mono text-muted-foreground">
                        {project.branch ?? '—'} @ {project.head ?? '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </HoverCardContent>
            </HoverCard>
          )}
        </div>
        {runningTurns > 0 && (
          <Badge variant="secondary" className="gap-1"><Spinner className="size-3" />{runningTurns} 运行中</Badge>
        )}
        <Button variant={inspectorOpen ? 'secondary' : 'ghost'} size="icon-sm" aria-label="检查器" onClick={onToggleInspector}>
          <PanelRight />
        </Button>
      </div>
      {error !== '' && (
        <div className="px-4 pb-3">
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
            <AlertAction>
              <Button variant="ghost" size="icon-xs" aria-label="关闭错误" onClick={onDismissError}><X /></Button>
            </AlertAction>
          </Alert>
        </div>
      )}
    </header>
  );
}
