import { BookOpen, FilePenLine, Send, ShieldAlert, TriangleAlert } from 'lucide-react';
import { Elapsed } from '@/renderer/components/elapsed';
import { StatusBadge } from '@/renderer/components/status-badge';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/renderer/components/ui/item';
import { itemStatusLabel } from '../model/describe.js';
import type { ActionModel } from '../model/types.js';
import { ContextItems } from './ContextItems.js';
import { useInspector } from './inspector/Inspector.js';

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
  return (
    <div className="flex flex-col gap-1">
      <Item
        variant="outline"
        size="xs"
        role="button"
        tabIndex={0}
        className="cursor-pointer"
        onClick={() => inspect({ kind: 'action', turnId, actionId: action.id })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') inspect({ kind: 'action', turnId, actionId: action.id });
        }}
      >
        <ItemMedia variant="icon" className="text-muted-foreground"><KindIcon kind={action.kind} /></ItemMedia>
        <ItemContent>
          <ItemTitle>{action.title}</ItemTitle>
          {action.subtitle && <ItemDescription>{action.subtitle}</ItemDescription>}
        </ItemContent>
        <ItemActions>
          <StatusBadge status={action.status} label={itemStatusLabel(action.status)} />
          <span className="text-xs text-muted-foreground"><Elapsed start={action.startedAt} end={action.endedAt} /></span>
        </ItemActions>
      </Item>
      {action.outputs.length > 0 && (
        <div className="ml-7"><ContextItems items={action.outputs} turnId={turnId} cycle={action.cycle} /></div>
      )}
      {action.writes.length > 0 && (
        <div className="ml-7 flex flex-col gap-0.5 text-xs text-muted-foreground">
          {action.writes.map((write) => (
            <span key={write.path} className="font-mono">
              {write.change === 'created' ? '新建' : '更新'} {write.path}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
