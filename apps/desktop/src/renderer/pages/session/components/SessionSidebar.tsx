import { ChevronRight, Search, SquarePen, Trash2 } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible';
import { Spinner } from '@/renderer/components/ui/spinner';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/renderer/components/ui/sidebar';
import { useNow } from '@/renderer/hooks/use-now';
import { dateGroupOf, type DateGroup } from '@/renderer/lib/format';
import type { SessionSummary } from '../model/types.js';

const GROUPS: DateGroup[] = ['今天', '昨天', '7 天内', '更早'];

export interface SessionSidebarProps {
  sessions: SessionSummary[];
  selectedId: string;
  loading: boolean;
  onSelect(sessionId: string): void;
  onNew(): void;
  onSearch(): void;
  onDelete(sessionId: string): void;
}

/**
 * The session list: new/search actions plus collapsible date groups. It renders
 * a bare `Sidebar` (collapsible none); the page owns the surrounding
 * `SidebarProvider` and the panel it collapses.
 */
export function SessionSidebar({ sessions, selectedId, loading, onSelect, onNew, onSearch, onDelete }: SessionSidebarProps) {
  const now = useNow();
  const grouped = new Map<DateGroup, SessionSummary[]>();
  const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const session of sorted) {
    const group = dateGroupOf(session.updatedAt, now);
    const bucket = grouped.get(group);
    if (bucket) bucket.push(session);
    else grouped.set(group, [session]);
  }

  return (
    <Sidebar collapsible="none" className="w-full">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onNew} aria-label="新建对话">
              <SquarePen />
              <span>新建对话</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onSearch} aria-label="搜索对话">
              <Search />
              <span>搜索</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {loading && sessions.length === 0 && (
          <SidebarGroup>
            <SidebarMenu>
              {[0, 1, 2].map((index) => (
                <SidebarMenuItem key={index}>
                  <SidebarMenuSkeleton />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
        {!loading && sessions.length === 0 && (
          <SidebarGroup>
            <p className="text-muted-foreground">还没有对话</p>
          </SidebarGroup>
        )}
        {GROUPS.map((group) => {
          const list = grouped.get(group);
          if (!list || list.length === 0) return null;
          return (
            <Collapsible key={group} defaultOpen render={<SidebarGroup />}>
              <SidebarGroupLabel
                className="group/label cursor-pointer"
                render={<CollapsibleTrigger />}
              >
                {group}
                <ChevronRight className="ml-auto transition-transform group-data-[panel-open]/label:rotate-90" />
              </SidebarGroupLabel>
              <CollapsibleContent>
                <SidebarMenu>
                  {list.map((session) => (
                    <SidebarMenuItem key={session.sessionId}>
                      <SidebarMenuButton
                        isActive={session.sessionId === selectedId}
                        onClick={() => onSelect(session.sessionId)}
                        className="group-has-data-[sidebar=menu-action]/menu-item:pr-3 group-has-data-[sidebar=menu-action]/menu-item:group-hover/menu-item:pr-8 group-has-data-[sidebar=menu-action]/menu-item:group-focus-within/menu-item:pr-8"
                      >
                        {session.running === true ? (
                          <>
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                              <Spinner className="size-4" />
                            </span>
                            <span className="min-w-0 flex-1 [text-overflow:clip]! [mask-image:linear-gradient(to_right,#000_calc(100%_-_2rem),transparent)]">{session.title}</span>
                          </>
                        ) : (
                          <span className="min-w-0 flex-1 [text-overflow:clip]! [mask-image:linear-gradient(to_right,#000_calc(100%_-_2rem),transparent)]">{session.title}</span>
                        )}
                      </SidebarMenuButton>
                      <SidebarMenuAction
                        showOnHover
                        aria-label="删除对话"
                        title={session.running === true ? '运行中无法删除' : '删除对话'}
                        disabled={session.running === true}
                        onClick={() => onDelete(session.sessionId)}
                      >
                        <Trash2 />
                      </SidebarMenuAction>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </SidebarContent>
    </Sidebar>
  );
}
