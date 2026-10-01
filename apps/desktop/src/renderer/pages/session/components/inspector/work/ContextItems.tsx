import { BookMarked, Brain, FileText } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/renderer/components/ui/item';
import { materialTitle } from '../../../model/describe.js';
import type { ContextItem } from '../../../model/types.js';
import { useInspector } from '../Inspector.js';

function directory(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function KindIcon({ kind }: { kind: ContextItem['kind'] }) {
  if (kind === 'memory') return <Brain className="text-chart-1" />;
  if (kind === 'instructions') return <BookMarked className="text-chart-2" />;
  return <FileText className="text-muted-foreground" />;
}

export interface ContextItemsProps {
  items: ContextItem[];
  turnId: number;
  cycle?: number;
}

/** Uniform rows for every loaded document or memory. */
export function ContextItems({ items, turnId, cycle }: ContextItemsProps) {
  const { inspect } = useInspector();
  if (items.length === 0) return <p className="text-muted-foreground">未加载新资料</p>;
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((item) => {
        const row = (
          <Item
            key={item.key}
            render={<button type="button" />}
            size="sm"
            onClick={() => inspect({ kind: 'context', turnId, key: item.key, ...(cycle === undefined ? {} : { cycle }) })}
          >
            <ItemMedia variant="icon"><KindIcon kind={item.kind} /></ItemMedia>
            <ItemContent>
              <ItemTitle>{materialTitle(item)}</ItemTitle>
              <ItemDescription>{directory(item.path)}</ItemDescription>
            </ItemContent>
          </Item>
        );
        return item.reason
          ? <Tooltip key={item.key}><TooltipTrigger render={row} /><TooltipContent side="top">{item.reason}</TooltipContent></Tooltip>
          : row;
      })}
    </div>
  );
}
