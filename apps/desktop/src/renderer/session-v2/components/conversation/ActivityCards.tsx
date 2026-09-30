import { Elapsed } from '@/renderer/components/elapsed';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/renderer/components/ui/item';
import { openTaskTranscript } from '@/renderer/lib/desktop';
import type { ActionModel, TurnModel } from '../../model/types.js';

function ActivityCard({ action }: { action: ActionModel }) {
  const parsed = action.parsed as { project?: string; task?: string } | undefined;
  const name = action.task?.taskName ?? parsed?.task ?? action.title;
  const project = parsed?.project;
  const open = (): void => {
    if (action.taskRunId) void openTaskTranscript(action.taskRunId);
  };
  return (
    <Item
      render={<button type="button" />}
      variant="outline"
      size="xs"
      className="w-64 cursor-pointer text-left border-primary/40 animate-pulse hover:animate-none"
      onClick={open}
    >
      <ItemMedia>
        <span className="size-2 rounded-full bg-primary" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        <ItemDescription>
          {project ? `${project} · ` : ''}{action.task?.runtime ?? '运行中'}
        </ItemDescription>
      </ItemContent>
      <span className="shrink-0 text-xs text-muted-foreground"><Elapsed start={action.startedAt} /></span>
    </Item>
  );
}

export interface ActivityCardsProps {
  turn: TurnModel;
}

/** Running dispatch tasks; hidden once the turn ends. */
export function ActivityCards({ turn }: ActivityCardsProps) {
  if (turn.status !== 'running') return null;
  const active = turn.actions.filter((action) => action.kind === 'dispatch' && action.status === 'running');
  if (active.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {active.map((action) => <ActivityCard key={action.id} action={action} />)}
    </div>
  );
}
