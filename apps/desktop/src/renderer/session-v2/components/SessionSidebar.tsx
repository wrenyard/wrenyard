import { useState } from 'react';
import { SquarePen } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Item, ItemContent, ItemTitle } from '@/renderer/components/ui/item';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { useNow } from '@/renderer/hooks/use-now';
import { dateGroupOf, formatRelative, type DateGroup } from '@/renderer/lib/format';
import { cn } from '@/renderer/lib/utils';
import type { SessionSummary } from '../model/types.js';

const GROUPS: DateGroup[] = ['今天', '昨天', '7 天内', '更早'];

export interface SessionSidebarProps {
  sessions: SessionSummary[];
  selectedId: string;
  loading: boolean;
  running: boolean;
  onSelect(sessionId: string): void;
  onNew(): void;
}

/** Session list with search, date grouping and a running indicator. */
export function SessionSidebar({ sessions, selectedId, loading, running, onSelect, onNew }: SessionSidebarProps) {
  const [query, setQuery] = useState('');
  const now = useNow();
  const filtered = sessions.filter((session) => session.title.toLowerCase().includes(query.toLowerCase()));

  const grouped = new Map<DateGroup, SessionSummary[]>();
  for (const session of filtered) {
    const group = dateGroupOf(session.updatedAt, now);
    const bucket = grouped.get(group);
    if (bucket) bucket.push(session);
    else grouped.set(group, [session]);
  }

  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-border">
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <span className="text-sm font-semibold">会话</span>
        <Button variant="ghost" size="icon-sm" aria-label="新建会话" onClick={onNew}><SquarePen /></Button>
      </div>
      <div className="px-3 pb-2">
        <Input value={query} placeholder="搜索…" className="h-7" onChange={(event) => setQuery(event.target.value)} />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-2 pb-3">
          {loading && sessions.length === 0 && [0, 1, 2].map((index) => <Skeleton key={index} className="h-8 w-full" />)}
          {!loading && filtered.length === 0 && <p className="px-2 py-4 text-xs text-muted-foreground">还没有会话</p>}
          {GROUPS.map((group) => {
            const list = grouped.get(group);
            if (!list || list.length === 0) return null;
            return (
              <div key={group} className="flex flex-col gap-0.5">
                <span className="px-2 pt-2 text-[10px] font-medium text-muted-foreground">{group}</span>
                {list.map((session) => (
                  <Item
                    key={session.sessionId}
                    size="xs"
                    render={<button type="button" />}
                    className={cn('cursor-pointer', session.sessionId === selectedId && 'bg-muted')}
                    onClick={() => onSelect(session.sessionId)}
                  >
                    <ItemContent>
                      <ItemTitle className="gap-1.5">
                        {running && session.sessionId === selectedId && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
                        <span className="truncate">{session.title}</span>
                      </ItemTitle>
                    </ItemContent>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelative(session.updatedAt, now)}</span>
                  </Item>
                ))}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </aside>
  );
}
