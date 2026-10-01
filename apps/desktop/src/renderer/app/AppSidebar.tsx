import appIcon from '../../../resources/icon.png?url';
import type { ShellPage } from '@/shell-contract';
import { shell } from '@/renderer/lib/desktop';
import { PRIMARY_NAV, SETTINGS_NAV, UPDATE_NAV } from '@/renderer/app/nav';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/renderer/components/ui/sidebar';

export interface AppSidebarProps {
  page: ShellPage;
  /** Whether an update is actionable; controls the footer update entry. */
  updateVisible: boolean;
  onOpenUpdate: () => void;
}

/**
 * Fixed icon activity rail. It is always collapsed, so the app icon is a
 * decorative local resource and the primary entries keep their tooltips.
 */
export function AppSidebar({ page, updateVisible, onOpenUpdate }: AppSidebarProps) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<div />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg">
                <img className="h-full w-full" src={appIcon} alt="" aria-hidden="true" />
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

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
          {updateVisible && (
            <SidebarMenuItem>
              <SidebarMenuButton tooltip={UPDATE_NAV.label} onClick={onOpenUpdate}>
                <UPDATE_NAV.icon />
                <span>{UPDATE_NAV.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
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
