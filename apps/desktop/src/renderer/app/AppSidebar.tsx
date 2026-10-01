import type { ShellPage } from '@/shell-contract';
import { shell } from '@/renderer/lib/desktop';
import { PRIMARY_NAV, SETTINGS_NAV } from '@/renderer/app/nav';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/renderer/components/ui/sidebar';

export interface AppSidebarProps {
  page: ShellPage;
}

/**
 * Fixed icon activity rail. It is always collapsed. The official `sidebar-16`
 * pattern (registered full-app exception) pins it between the title bar and
 * the status bar instead of the full window height; the update entry is owned
 * by the status bar's update item, not this footer.
 */
export function AppSidebar({ page }: AppSidebarProps) {
  return (
    <Sidebar
      collapsible="icon"
      className="top-(--titlebar-height) h-[calc(100svh_-_var(--titlebar-height)_-_var(--statusbar-height))]!"
    >
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
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
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
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
      </SidebarFooter>
    </Sidebar>
  );
}
