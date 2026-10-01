import { Button } from '@/renderer/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/renderer/components/ui/hover-card';
import { Separator } from '@/renderer/components/ui/separator';
import { Timestamp } from '@/renderer/components/timestamp';
import { formatCount, formatSnapshotStamp } from '@/renderer/lib/format';
import type { SessionModel, SessionSummary } from '../model/types.js';

export interface SessionTitleProps {
  title: string;
  session?: SessionSummary;
  snapshot: SessionModel['snapshot'];
  turnCount: number;
  draft: boolean;
}

/** Title-bar session title; a hover card carries the session and snapshot facts. */
export function SessionTitle({ title, session, snapshot, turnCount, draft }: SessionTitleProps) {
  const label = draft ? '新对话' : title;
  if (draft) {
    return <Button variant="ghost" className="max-w-80 truncate text-base font-medium">{label}</Button>;
  }
  return (
    <HoverCard>
      <HoverCardTrigger render={<Button variant="ghost" className="max-w-80 truncate text-base font-medium" />}>
        {label}
      </HoverCardTrigger>
      <HoverCardContent className="w-80">
        <div className="flex flex-col gap-2">
          <span className="font-medium">{label}</span>
          {session && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
              <span className="flex items-center gap-1">创建 <Timestamp value={session.createdAt} /></span>
              <span className="flex items-center gap-1">活跃 <Timestamp value={session.updatedAt} /></span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <span>轮次 {formatCount(turnCount)}</span>
            {snapshot && <span>快照 {formatSnapshotStamp(snapshot.takenAt)} · {formatCount(snapshot.projects.length)} 个项目</span>}
          </div>
          {snapshot && snapshot.projects.length > 0 && (
            <>
              <Separator />
              <div className="flex flex-col gap-1">
                {snapshot.projects.map((project) => (
                  <div key={project.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">{project.displayName ?? project.id}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {project.branch ?? '—'} @ {project.head ?? '—'}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          {snapshot && <span className="text-muted-foreground">设备 {snapshot.deviceName}</span>}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
