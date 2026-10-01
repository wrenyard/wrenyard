import { ChevronRight, Search, SquarePen } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible';
import { Spinner } from '@/renderer/components/ui/spinner';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
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
  running: boolean;
  onSelect(sessionId: string): void;
  onNew(): void;
  onSearch(): void;
}

/**
 * The session list: new/search actions plus collapsible date groups. It renders
 * a bare `Sidebar` (collapsible none); the page owns the surrounding
 * `SidebarProvider` and the panel it collapses.
 */
export function SessionSidebar({ sessions, selectedId, loading, running, onSelect, onNew, onSearch }: SessionSidebarProps) {
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
                      >
                        <span>{session.title}</span>
                      </SidebarMenuButton>
                      {running && session.sessionId === selectedId && (
                        <SidebarMenuBadge><Spinner /></SidebarMenuBadge>
                      )}
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
