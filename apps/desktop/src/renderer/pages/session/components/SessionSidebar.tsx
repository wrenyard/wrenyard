import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Search,
  SlidersHorizontal,
  SquarePen,
  Trash2,
} from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionGroupBy, SessionSortBy, SessionStatusFilter } from '@/shell-contract';
import {
  SESSION_GROUP_BY_DEFAULT,
  SESSION_SORT_BY_DEFAULT,
  SESSION_STATUS_FILTER_DEFAULT,
} from '@/shell-contract';
import { Button } from '@/renderer/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/renderer/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
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
import { toast } from '@/renderer/lib/notify';
import { useSessionSeen } from '@/renderer/lib/session-seen';
import { usePreferenceMutation, usePreferencesQuery } from '@/renderer/pages/settings/queries';
import { SessionDot } from './SessionDot';
import { sessionStatusOf } from '../model/session-status.js';
import type { SessionSummary } from '../model/types.js';

const GROUPS: DateGroup[] = ['今天', '昨天', '7 天内', '更早'];

const GROUP_BY_OPTIONS: ReadonlyArray<{ value: SessionGroupBy; label: string }> = [
  { value: 'date', label: '日期' },
  { value: 'status', label: '状态' },
  { value: 'none', label: '不分组' },
];

const SORT_BY_OPTIONS: ReadonlyArray<{ value: SessionSortBy; label: string }> = [
  { value: 'updated', label: '最近更新' },
  { value: 'created', label: '创建时间' },
  { value: 'title', label: '标题' },
];

const STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: SessionStatusFilter; label: string }> = [
  { value: 'active', label: '进行中' },
  { value: 'archived', label: '已归档' },
  { value: 'all', label: '全部' },
];

/** Deterministic order; every sort breaks ties on the session id. */
function compareSessions(a: SessionSummary, b: SessionSummary, sortBy: SessionSortBy): number {
  if (sortBy === 'updated' && a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  if (sortBy === 'created' && a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (sortBy === 'title') {
    const byTitle = a.title.localeCompare(b.title, 'zh-Hans');
    if (byTitle !== 0) return byTitle;
  }
  return a.sessionId.localeCompare(b.sessionId);
}

function filterByStatus(sessions: readonly SessionSummary[], filter: SessionStatusFilter): SessionSummary[] {
  if (filter === 'archived') return sessions.filter((session) => session.archived === true);
  if (filter === 'all') return [...sessions];
  return sessions.filter((session) => session.archived !== true);
}

export interface SessionSidebarProps {
  sessions: SessionSummary[];
  selectedId: string;
  loading: boolean;
  onSelect(sessionId: string): void;
  onNew(): void;
  onSearch(): void;
  onDelete(sessionId: string): void;
  onRename(sessionId: string, title: string): Promise<void>;
  onUpdateMetadata(sessionId: string, patch: { archived?: boolean; pinned?: boolean }): Promise<void>;
  /** Replaces the default new/search header when composed into a host sidebar. */
  header?: ReactNode;
  /** Extra rows rendered below the scrolling list, pinned to the bottom. */
  footer?: ReactNode;
}

interface SessionRowProps {
  session: SessionSummary;
  selected: boolean;
  seen: ReturnType<typeof useSessionSeen>;
  editing: boolean;
  onSelect(): void;
  onDelete(): void;
  onStartRename(): void;
  onCancelRename(): void;
  onRename(title: string): Promise<void>;
  onUpdateMetadata(patch: { archived?: boolean; pinned?: boolean }): void;
}

/**
 * One conversation row: the select button (or an inline rename editor) plus the
 * accessible `...` menu offering archive, pin, rename and delete.
 */
function SessionRow({
  session,
  selected,
  seen,
  editing,
  onSelect,
  onDelete,
  onStartRename,
  onCancelRename,
  onRename,
  onUpdateMetadata,
}: SessionRowProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  const archived = session.archived === true;
  const pinned = session.pinned === true;

  const commit = async (): Promise<void> => {
    if (settled.current) return;
    const trimmed = (inputRef.current?.value ?? '').trim();
    if (trimmed === '') {
      toast('标题不能为空', { level: 'error' });
      return;
    }
    settled.current = true;
    if (trimmed === session.title) {
      onCancelRename();
      return;
    }
    try {
      await onRename(trimmed);
      onCancelRename();
    } catch {
      // The failure is surfaced by the rename handler; keep editing.
      settled.current = false;
    }
  };

  return (
    <SidebarMenuItem>
      {editing ? (
        <input
          ref={inputRef}
          defaultValue={session.title}
          autoFocus
          aria-label="会话标题"
          className="h-8 w-full min-w-0 rounded-xl bg-sidebar-accent px-2 text-sm text-sidebar-accent-foreground outline-none ring-sidebar-ring focus-visible:ring-2"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void commit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              settled.current = true;
              onCancelRename();
            }
          }}
          onBlur={() => {
            void commit();
          }}
        />
      ) : (
        <SidebarMenuButton
          isActive={selected}
          onClick={onSelect}
          className="group-has-data-[sidebar=menu-action]/menu-item:pr-3 group-has-data-[sidebar=menu-action]/menu-item:group-hover/menu-item:pr-8 group-has-data-[sidebar=menu-action]/menu-item:group-focus-within/menu-item:pr-8"
        >
          <SessionDot status={sessionStatusOf(session, seen)} />
          <span className="min-w-0 flex-1 [text-overflow:clip]! [mask-image:linear-gradient(to_right,#000_calc(100%_-_2rem),transparent)]">{session.title}</span>
        </SidebarMenuButton>
      )}
      {!editing && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuAction showOnHover aria-label="更多操作" title="更多操作" />}
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-40">
            <DropdownMenuItem onClick={() => { onUpdateMetadata({ archived: !archived }); }}>
              {archived ? <ArchiveRestore /> : <Archive />}
              {archived ? '取消归档' : '归档'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => { onUpdateMetadata({ pinned: !pinned }); }}>
              {pinned ? <PinOff /> : <Pin />}
              {pinned ? '取消置顶' : '置顶'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onStartRename}>
              <Pencil />
              重命名
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={session.running === true}
              onClick={onDelete}
            >
              <Trash2 />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </SidebarMenuItem>
  );
}

/**
 * The session list: an options menu (grouping / sorting / status filter), a
 * pinned section, and the grouped list. It renders a bare `Sidebar`
 * (collapsible none); it is composed into the shell's global sidebar, which
 * supplies the `header`/`footer` slots and owns the `SidebarProvider`. The
 * grouped list keeps its own scrolling without a second implementation.
 */
export function SessionSidebar({
  sessions,
  selectedId,
  loading,
  onSelect,
  onNew,
  onSearch,
  onDelete,
  onRename,
  onUpdateMetadata,
  header,
  footer,
}: SessionSidebarProps) {
  const now = useNow();
  const seen = useSessionSeen();
  const preferences = usePreferencesQuery();
  const setPreference = usePreferenceMutation();
  const [editingId, setEditingId] = useState<string | null>(null);

  const groupBy = preferences.data?.session.groupBy ?? SESSION_GROUP_BY_DEFAULT;
  const sortBy = preferences.data?.session.sortBy ?? SESSION_SORT_BY_DEFAULT;
  const statusFilter = preferences.data?.session.statusFilter ?? SESSION_STATUS_FILTER_DEFAULT;

  const ordered = useMemo(
    () => filterByStatus(sessions, statusFilter).sort((a, b) => compareSessions(a, b, sortBy)),
    [sessions, statusFilter, sortBy],
  );
  const pinned = ordered.filter((session) => session.pinned === true);
  const rest = ordered.filter((session) => session.pinned !== true);

  const dateBuckets = new Map<DateGroup, SessionSummary[]>();
  if (groupBy === 'date') {
    for (const session of rest) {
      const group = dateGroupOf(session.updatedAt, now);
      const bucket = dateBuckets.get(group);
      if (bucket) bucket.push(session);
      else dateBuckets.set(group, [session]);
    }
  }

  const setOption = (id: 'session.groupBy' | 'session.sortBy' | 'session.statusFilter', value: unknown): void => {
    setPreference.mutate({ id, value: String(value) });
  };

  const row = (session: SessionSummary): ReactNode => (
    <SessionRow
      key={session.sessionId}
      session={session}
      selected={session.sessionId === selectedId}
      seen={seen}
      editing={editingId === session.sessionId}
      onSelect={() => onSelect(session.sessionId)}
      onDelete={() => onDelete(session.sessionId)}
      onStartRename={() => setEditingId(session.sessionId)}
      onCancelRename={() => setEditingId((current) => (current === session.sessionId ? null : current))}
      onRename={(title) => onRename(session.sessionId, title)}
      onUpdateMetadata={(patch) => { void onUpdateMetadata(session.sessionId, patch); }}
    />
  );

  const listOptions = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label="列表选项" title="列表选项" />}
      >
        <SlidersHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>分组</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={groupBy} onValueChange={(value) => setOption('session.groupBy', value)}>
              {GROUP_BY_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>{option.label}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>排序</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={sortBy} onValueChange={(value) => setOption('session.sortBy', value)}>
              {SORT_BY_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>{option.label}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>状态</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={statusFilter} onValueChange={(value) => setOption('session.statusFilter', value)}>
              {STATUS_FILTER_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>{option.label}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const section = (key: string, label: string, list: SessionSummary[], trailing?: ReactNode): ReactNode => {
    if (list.length === 0) return null;
    return (
      <Collapsible key={key} defaultOpen render={<SidebarGroup />}>
        <SidebarGroupLabel>
          <CollapsibleTrigger className="group/label flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-xl outline-hidden ring-sidebar-ring focus-visible:ring-3">
            <span className="truncate">{label}</span>
            <ChevronRight className="size-4 shrink-0 opacity-0 transition-transform group-hover/label:opacity-100 group-focus-visible/label:opacity-100 group-not-data-[panel-open]/label:opacity-100 group-data-[panel-open]/label:rotate-90" />
          </CollapsibleTrigger>
          {trailing}
        </SidebarGroupLabel>
        <CollapsibleContent>
          <SidebarMenu>{list.map(row)}</SidebarMenu>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  const sections: Array<{ key: string; label: string; list: SessionSummary[] }> = [];
  if (pinned.length > 0) sections.push({ key: 'pinned', label: '置顶', list: pinned });
  if (groupBy === 'date') {
    for (const group of GROUPS) {
      const list = dateBuckets.get(group) ?? [];
      if (list.length > 0) sections.push({ key: `date:${group}`, label: group, list });
    }
  } else if (groupBy === 'status') {
    const active = rest.filter((session) => session.archived !== true);
    const archived = rest.filter((session) => session.archived === true);
    if (active.length > 0) sections.push({ key: 'status:active', label: '进行中', list: active });
    if (archived.length > 0) sections.push({ key: 'status:archived', label: '已归档', list: archived });
  }

  return (
    <Sidebar collapsible="none" className="min-h-0 w-full">
      {header ?? (
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
      )}
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

        {sections.length === 0 && (
          <div className="flex h-8 shrink-0 items-center justify-end px-3">{listOptions}</div>
        )}
        {sections.map((item, index) => section(item.key, item.label, item.list, index === 0 ? listOptions : undefined))}
        {groupBy === 'none' && rest.length > 0 && (
          <SidebarGroup>
            <SidebarMenu>{rest.map(row)}</SidebarMenu>
          </SidebarGroup>
        )}
        {!loading && sessions.length > 0 && ordered.length === 0 && (
          <SidebarGroup>
            <p className="text-muted-foreground">没有符合条件的对话</p>
          </SidebarGroup>
        )}
      </SidebarContent>
      {footer !== undefined && <SidebarFooter className="mt-2 shrink-0 border-t border-sidebar-border bg-sidebar pt-3">{footer}</SidebarFooter>}
    </Sidebar>
  );
}
