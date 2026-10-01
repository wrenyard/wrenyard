import { BookOpen, FilePenLine, Send, ShieldAlert, TriangleAlert } from 'lucide-react';
import { Elapsed } from '@/renderer/components/elapsed';
import { StatusBadge } from '@/renderer/components/status-badge';
import { Button } from '@/renderer/components/ui/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/renderer/components/ui/item';
import { openTaskTranscript } from '@/renderer/lib/desktop';
import { statusView } from '../../../model/describe.js';
import type { ActionModel } from '../../../model/types.js';
import { ContextItems } from './ContextItems.js';
import { useInspector } from '../Inspector.js';

function KindIcon({ kind }: { kind: ActionModel['kind'] }) {
  switch (kind) {
    case 'dispatch': return <Send />;
    case 'read': return <BookOpen />;
    case 'write-doc': return <FilePenLine />;
    case 'unsupported': return <TriangleAlert />;
    case 'parse-failed': return <ShieldAlert />;
  }
}

export interface ActionRowProps {
  action: ActionModel;
  turnId: number;
}

/** One-line action summary; details live in the inspector. */
export function ActionRow({ action, turnId }: ActionRowProps) {
  const { inspect } = useInspector();
  const select = (): void => inspect({ kind: 'action', turnId, actionId: action.id });
  const transcriptId = action.kind === 'dispatch' ? action.taskRunId : undefined;
  const subtitle = action.kind === 'dispatch' && action.status === 'running'
    ? action.task?.runtime ?? action.subtitle
    : action.subtitle;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Item
          variant="muted"
          render={<button type="button" />}
          className="min-w-0 flex-1 text-left"
          onClick={select}
        >
          <ItemMedia variant="icon" className="text-muted-foreground"><KindIcon kind={action.kind} /></ItemMedia>
          <ItemContent>
            <ItemTitle>{action.title}</ItemTitle>
            {subtitle && <ItemDescription>{subtitle}</ItemDescription>}
          </ItemContent>
          <ItemActions>
            <StatusBadge {...statusView(action.status)} />
            <ItemDescription><Elapsed start={action.startedAt} end={action.endedAt} /></ItemDescription>
          </ItemActions>
        </Item>
        {transcriptId !== undefined && (
          <Button variant="outline" size="sm" onClick={() => { void openTaskTranscript(transcriptId); }}>
            查看任务
          </Button>
        )}
      </div>
      {action.outputs.length > 0 && (
        <div className="ml-7"><ContextItems items={action.outputs} turnId={turnId} cycle={action.cycle} /></div>
      )}
      {action.writes.length > 0 && (
        <div className="ml-7 flex flex-col gap-0.5 text-muted-foreground">
          {action.writes.map((write) => (
            <span key={write.path}>
              {write.change === 'created' ? '新建' : '更新'} {write.path}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
