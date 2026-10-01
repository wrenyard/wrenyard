import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { ShellPage } from '@/shell-contract';
import { cn } from 'cn';
import { Button } from '@/renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { SourceDevelopmentBadge } from '@/renderer/components/source-development-badge';
import { shell, useShellPage } from '@/renderer/lib/desktop';
import { back, forward, toggleSecondarySidebar, useNavigation, useSecondarySidebarToggle } from '@/renderer/lib/navigation';
import { registerTitleBarSlot } from '@/renderer/lib/titlebar';

/** Slots are reserved for every shell page; only the active page's is shown. */
const TITLE_BAR_PAGES: readonly ShellPage[] = ['session', 'stats', 'quota', 'tasks', 'settings'];

// Whole-app exceptions (chrome spec 2): the drag/no-drag regions live only in
// this file. Every interactive child re-enables pointer events.
const DRAG = '[-webkit-app-region:drag] [app-region:drag]';
const NO_DRAG = '[-webkit-app-region:no-drag] [app-region:no-drag]';

interface TitleBarButtonProps {
  label: string;
  tooltip: string;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}

function TitleBarButton({ label, tooltip, disabled, onClick, children }: TitleBarButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Full-width title bar: window controls reserve, sidebar/history buttons, the
 * dev badge, the active page's title slot and its auxiliary slot. The page
 * header and auxiliary content are portaled into the slots by `components/page`.
 */
export function TitleBar() {
  const page = useShellPage();
  const navigation = useNavigation();
  const sidebar = useSecondarySidebarToggle();
  const isMac = shell.platform === 'darwin';
  const isWindows = shell.platform === 'win32';
  const sidebarLabel = sidebar.open ? '折叠侧栏' : '展开侧栏';
  const modifier = isMac ? '⌘' : 'Ctrl+';
  const backShortcut = isMac ? '⌘[' : 'Alt+←';
  const forwardShortcut = isMac ? '⌘]' : 'Alt+→';

  return (
    <header
      data-titlebar
      className={cn(
        'flex h-(--titlebar-height) shrink-0 items-center gap-1 border-b bg-sidebar pr-(--titlebar-inset-end) pl-(--titlebar-inset-start)',
        DRAG,
      )}
    >
      <div className={cn('flex items-center gap-1', NO_DRAG)}>
        {isWindows && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="菜单"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    void shell.showAppMenu({ x: rect.left, y: rect.bottom });
                  }}
                />
              }
            >
              <Menu />
            </TooltipTrigger>
            <TooltipContent>菜单</TooltipContent>
          </Tooltip>
        )}
        <TitleBarButton
          label={sidebarLabel}
          tooltip={`${sidebarLabel} ${modifier}B`}
          disabled={!sidebar.available}
          onClick={toggleSecondarySidebar}
        >
          {sidebar.open ? <PanelLeftClose /> : <PanelLeftOpen />}
        </TitleBarButton>
        <TitleBarButton label="后退" tooltip={`后退 ${backShortcut}`} disabled={!navigation.canBack} onClick={back}>
          <ChevronLeft />
        </TitleBarButton>
        <TitleBarButton label="前进" tooltip={`前进 ${forwardShortcut}`} disabled={!navigation.canForward} onClick={forward}>
          <ChevronRight />
        </TitleBarButton>
        <SourceDevelopmentBadge />
      </div>

      <div className={cn('flex min-w-0 flex-1 items-center gap-2', NO_DRAG)}>
        {TITLE_BAR_PAGES.map((id) => (
          <div
            key={id}
            data-titlebar-slot={id}
            className={cn('flex min-w-0 flex-1 items-center gap-2', id !== page && 'hidden')}
            ref={(element) => registerTitleBarSlot(id, 'title', element)}
          />
        ))}
      </div>

      <div className={cn('flex items-center gap-1', NO_DRAG)}>
        {TITLE_BAR_PAGES.map((id) => (
          <div
            key={id}
            data-titlebar-auxiliary={id}
            className={cn('flex items-center gap-1', id !== page && 'hidden')}
            ref={(element) => registerTitleBarSlot(id, 'auxiliary', element)}
          />
        ))}
      </div>
    </header>
  );
}
