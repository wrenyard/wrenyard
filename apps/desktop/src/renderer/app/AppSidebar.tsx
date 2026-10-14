import { Search, SquarePen } from 'lucide-react';
import type { ShellPage } from '@/shell-contract';
import { shell } from '@/renderer/lib/desktop';
import { PRIMARY_NAV, SETTINGS_NAV } from '@/renderer/app/nav';
import { executeCommand } from '@/renderer/lib/commands';
import { useSessionListQuery } from '@/renderer/lib/queries';
import { useActiveSession } from '@/renderer/lib/navigation';
import { SessionSidebar } from '@/renderer/pages/session/components/SessionSidebar';
import { UpdateItem } from '@/renderer/app/statusbar/UpdateItem';
import {
  Sidebar,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/renderer/components/ui/sidebar';

export interface AppSidebarProps {
  page: ShellPage;
  onOpenUpdate: () => void;
}

/**
 * The shell's single global sidebar (`offcanvas`, no icon rail): a top group of
 * full-width route rows (new conversation plus the feature pages), the shared
 * conversation list with its own scrolling, and the update and settings rows
 * pinned at the bottom. The list is composed through `SessionSidebar`'s header
 * and footer slots so there is only one conversation-list implementation.
 */
export function AppSidebar({ page, onOpenUpdate }: AppSidebarProps) {
  const sessions = useSessionListQuery();
  const selectedId = useActiveSession();

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
    <SidebarMenu>
      <UpdateItem onOpenUpdate={onOpenUpdate} />
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={SETTINGS_NAV.label}
          isActive={page === SETTINGS_NAV.id}
          aria-current={page === SETTINGS_NAV.id ? 'page' : undefined}
          onClick={() => void shell.navigate(SETTINGS_NAV.id)}
        >
          <SETTINGS_NAV.icon />
          <span>{SETTINGS_NAV.label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );

  return (
    <Sidebar
      collapsible="offcanvas"
      className="top-(--titlebar-height) h-[calc(100svh_-_var(--titlebar-height)_-_var(--statusbar-height))]!"
    >
      <SessionSidebar
        sessions={sessions.data ?? []}
        selectedId={selectedId}
        loading={sessions.isPending}
        onSelect={(sessionId) => { executeCommand('session.open', sessionId); }}
        onNew={() => { executeCommand('session.newDraft'); }}
        onSearch={() => { executeCommand('session.search'); }}
        onDelete={(sessionId) => { executeCommand('session.delete', sessionId); }}
        header={header}
        footer={footer}
      />
    </Sidebar>
  );
}
