import { Search, SquarePen } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { SESSION_STATUS_FILTER_DEFAULT, type ShellPage, type SessionStatusFilter } from '@/shell-contract';
import { shell } from '@/renderer/lib/desktop';
import { PRIMARY_NAV, SETTINGS_NAV } from '@/renderer/app/nav';
import { executeCommand } from '@/renderer/lib/commands';
import { sessionListQueryKey, useSessionListQuery } from '@/renderer/lib/queries';
import { useActiveSession } from '@/renderer/lib/navigation';
import { getSessionBridge } from '@/renderer/lib/session';
import { useConfirm } from '@/renderer/hooks/use-confirm';
import { toast } from '@/renderer/lib/notify';
import { SessionSidebar } from '@/renderer/pages/session/components/SessionSidebar';
import { DaemonItem } from '@/renderer/app/statusbar/DaemonItem';
import { Button } from '@/renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { usePreferencesQuery } from '@/renderer/pages/settings/queries';
import {
  Sidebar,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/renderer/components/ui/sidebar';
import { cn } from 'cn';

export interface AppSidebarProps {
  page: ShellPage;
  /** Opens the shared update dialog, forwarded to the Daemon menu's update entry. */
  onOpenUpdate: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a session survives under the persisted Status filter. */
function matchesStatusFilter(session: { archived?: boolean }, filter: SessionStatusFilter): boolean {
  if (filter === 'archived') return session.archived === true;
  if (filter === 'all') return true;
  return session.archived !== true;
}

/**
 * The shell's single global sidebar (`offcanvas`, no icon rail): a top group of
 * full-width route rows (new conversation plus the feature pages), the shared
 * conversation list with its own scrolling, and a bottom bar pinned at the
 * bottom. The bottom bar holds the long Daemon button (environment label and
 * connectivity, opening the daemon menu) on the left and a compact settings icon
 * button on the right. The list is composed through `SessionSidebar`'s header
 * and footer slots so there is only one conversation-list implementation.
 *
 * The list's row actions are wired here directly against the session bridge
 * (never through a session-page-only command), so grouping, sorting, filtering,
 * the pinned section and the row menu work on every page that renders the
 * sidebar.
 */
export function AppSidebar({ page, onOpenUpdate }: AppSidebarProps) {
  const sessions = useSessionListQuery();
  const selectedId = useActiveSession();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const preferences = usePreferencesQuery();
  const list = sessions.data ?? [];
  const statusFilter = preferences.data?.session.statusFilter ?? SESSION_STATUS_FILTER_DEFAULT;

  const invalidateList = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: sessionListQueryKey });

  const onDelete = (sessionId: string): void => {
    const session = list.find((candidate) => candidate.sessionId === sessionId);
    // The list cannot see the running flag reliably, so guard here as well as
    // in the row's disabled state.
    if (session?.running === true) return;
    void (async () => {
      const confirmed = await confirm({
        title: '删除此对话？',
        description: '删除后无法恢复。',
        confirmLabel: '删除对话',
        destructive: true,
      });
      if (!confirmed) return;
      try {
        await getSessionBridge().deleteSession(sessionId);
        await invalidateList();
        // Move the selection to a surviving conversation only while the session
        // page is showing it, so a delete from another page never yanks the
        // user back to the session page. The next row is the first one still
        // visible under the persisted Status filter; with none left, open a
        // fresh draft instead of selecting a filter-hidden row.
        if (page === 'session' && sessionId === selectedId) {
          const next = list.find(
            (candidate) => candidate.sessionId !== sessionId && matchesStatusFilter(candidate, statusFilter),
          );
          if (next) executeCommand('session.open', next.sessionId);
          else executeCommand('session.newDraft');
        }
      } catch (error) {
        toast(`删除失败：${errorMessage(error)}`, { level: 'error' });
      }
    })();
  };

  const onRename = async (sessionId: string, title: string): Promise<void> => {
    try {
      await getSessionBridge().renameSession(sessionId, title);
      await invalidateList();
    } catch (error) {
      toast(`重命名失败：${errorMessage(error)}`, { level: 'error' });
      throw error;
    }
  };

  const onUpdateMetadata = async (
    sessionId: string,
    patch: { archived?: boolean; pinned?: boolean },
  ): Promise<void> => {
    try {
      await getSessionBridge().updateMetadata(sessionId, patch);
      await invalidateList();
    } catch (error) {
      toast(`更新失败：${errorMessage(error)}`, { level: 'error' });
    }
  };

  const header = (
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton tooltip="新建对话" onClick={() => executeCommand('session.newDraft')}>
            <SquarePen />
            <span>新建对话</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton tooltip="搜索对话" onClick={() => executeCommand('session.search')}>
            <Search />
            <span>搜索</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {PRIMARY_NAV.map((item) => (
          <SidebarMenuItem key={item.id}>
            <SidebarMenuButton
              tooltip={item.label}
              isActive={page === item.id}
              aria-current={page === item.id ? 'page' : undefined}
              onClick={() => void shell.navigate(item.id)}
            >
              <item.icon />
              <span>{item.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarHeader>
  );

  const footer = (
    <div className="flex w-full items-center gap-1">
      <DaemonItem onOpenUpdate={onOpenUpdate} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={SETTINGS_NAV.label}
              aria-current={page === SETTINGS_NAV.id ? 'page' : undefined}
              className={cn(
                'shrink-0 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                page === SETTINGS_NAV.id && 'bg-sidebar-accent text-sidebar-accent-foreground',
              )}
              onClick={() => void shell.navigate(SETTINGS_NAV.id)}
            />
          }
        >
          <SETTINGS_NAV.icon />
        </TooltipTrigger>
        <TooltipContent side="top">{SETTINGS_NAV.label}</TooltipContent>
      </Tooltip>
    </div>
  );

  return (
    <Sidebar
      collapsible="offcanvas"
      className="top-(--titlebar-height) h-[calc(100svh_-_var(--titlebar-height)_-_var(--statusbar-height))]!"
    >
      <SessionSidebar
        sessions={list}
        selectedId={selectedId}
        loading={sessions.isPending}
        onSelect={(sessionId) => { executeCommand('session.open', sessionId); }}
        onNew={() => { executeCommand('session.newDraft'); }}
        onSearch={() => { executeCommand('session.search'); }}
        onDelete={onDelete}
        onRename={onRename}
        onUpdateMetadata={onUpdateMetadata}
        header={header}
        footer={footer}
      />
    </Sidebar>
  );
}
