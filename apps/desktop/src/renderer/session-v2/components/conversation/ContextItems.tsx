import { BookMarked, Brain, FileText } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { Item } from '@/renderer/components/ui/item';
import { materialTitle } from '../../model/describe.js';
import type { ContextItem } from '../../model/types.js';
import { useInspector } from '../inspector/Inspector.js';

function directory(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function KindIcon({ kind }: { kind: ContextItem['kind'] }) {
  if (kind === 'memory') return <Brain className="size-3.5 text-[var(--moss-deep)]" />;
  if (kind === 'instructions') return <BookMarked className="size-3.5 text-[var(--lamp-deep)]" />;
  return <FileText className="size-3.5 text-muted-foreground" />;
}

export interface ContextItemsProps {
  items: ContextItem[];
  turnId: number;
  cycle?: number;
}

/** Uniform rows for every loaded document or memory. */
export function ContextItems({ items, turnId, cycle }: ContextItemsProps) {
  const { inspect } = useInspector();
  if (items.length === 0) return <p className="text-xs text-muted-foreground">未加载新资料</p>;
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((item) => {
        const row = (
          <Item
            key={item.key}
            render={<button type="button" />}
            size="xs"
            className="gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-muted/50"
            onClick={() => inspect({ kind: 'context', turnId, key: item.key, ...(cycle === undefined ? {} : { cycle }) })}
          >
            <KindIcon kind={item.kind} />
            <span className="truncate">{materialTitle(item)}</span>
            <span className="shrink-0 truncate text-muted-foreground">{directory(item.path)}</span>
          </Item>
        );
        return item.reason
          ? <Tooltip key={item.key}><TooltipTrigger render={row} /><TooltipContent side="top">{item.reason}</TooltipContent></Tooltip>
          : row;
      })}
    </div>
  );
}
