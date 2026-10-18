import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Menu, PanelLeftClose, PanelLeftOpen, PictureInPicture2, Pin, PinOff, Plus, X } from 'lucide-react';
import type { ShellPage } from '@/shell-contract';
import { cn } from 'cn';
import { Button } from '@/renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { shell, useShellPage } from '@/renderer/lib/desktop';
import { closeCard, getCurrentSession, openMiniCard, restoreMain, setMiniPinned, useMiniMode, useMiniPinned } from '@/renderer/lib/mini';
import { back, forward, toggleSecondarySidebar, useNavigation, useSecondarySidebarToggle } from '@/renderer/lib/navigation';
import { registerTitleBarSlot } from '@/renderer/lib/titlebar';

/** Slots are reserved for every shell page; only the active page's is shown. */
const TITLE_BAR_PAGES: readonly ShellPage[] = ['session', 'stats', 'tasks', 'todo', 'settings'];

// Whole-app exceptions (chrome spec 2): the drag/no-drag regions live only in
// this file. Every interactive child re-enables pointer events.
const DRAG = '[-webkit-app-region:drag] [app-region:drag]';
const NO_DRAG = '[-webkit-app-region:no-drag] [app-region:no-drag]';

// The page title/auxiliary slots are draggable so the whole blank run of the
// title bar moves the window; interactive content inside them opts back out.
const SLOT_NO_DRAG =
  '[&_:is(button,a,input,textarea,select,[role=button],[role=combobox],[data-no-drag])]:[-webkit-app-region:no-drag] [&_:is(button,a,input,textarea,select,[role=button],[role=combobox],[data-no-drag])]:[app-region:no-drag]';

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
  const mini = useMiniMode();
  const pinned = useMiniPinned();

  // Mini card: a compact 36px drag strip. 置顶 sits at the far left; the middle
  // is a plain, non-interactive session title inside the drag region; the right
  // holds three buttons flush right (cards are frameless on every platform).
  if (mini) {
    return (
      <header
        data-titlebar
        className={cn('flex h-(--titlebar-height) shrink-0 items-center gap-1 border-b bg-sidebar pr-1.5 pl-1.5', DRAG)}
      >
        <div className={cn('flex shrink-0 items-center', NO_DRAG)}>
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={pinned ? '取消置顶' : '置顶'}
                  aria-pressed={pinned}
                  onClick={() => setMiniPinned(!pinned)}
                />
              )}
            >
              {pinned ? <Pin className="fill-current" /> : <PinOff />}
            </TooltipTrigger>
            <TooltipContent>{pinned ? '取消置顶' : '置顶'}</TooltipContent>
          </Tooltip>
        </div>
        <div
          data-titlebar-slot="session"
          className={cn('flex min-w-0 flex-1 items-center gap-2', DRAG)}
          ref={(element) => registerTitleBarSlot('session', 'title', element)}
        />
        <div className={cn('group/mini-actions flex shrink-0 items-center gap-1', NO_DRAG)}>
          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/mini-actions:opacity-100 has-[:focus-visible]:opacity-100 motion-reduce:transition-none [[data-motion=reduce]_&]:transition-none">
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button variant="ghost" size="icon-sm" aria-label="新建卡片" onClick={() => openMiniCard('')} />
                )}
              >
                <Plus />
              </TooltipTrigger>
              <TooltipContent>新建卡片</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="回到主窗口"
                    onClick={() => restoreMain(getCurrentSession())}
                  />
                )}
              >
                <Maximize2 />
              </TooltipTrigger>
              <TooltipContent>回到主窗口</TooltipContent>
            </Tooltip>
          </div>
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="关闭"
                  className="hover:text-destructive"
                  onClick={closeCard}
                />
              )}
            >
              <X />
            </TooltipTrigger>
            <TooltipContent>关闭</TooltipContent>
          </Tooltip>
        </div>
      </header>
    );
  }

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
      </div>

      <div className={cn('flex min-w-0 flex-1 items-center gap-2', DRAG, SLOT_NO_DRAG)}>
        {TITLE_BAR_PAGES.map((id) => (
          <div
            key={id}
            data-titlebar-slot={id}
            className={cn('flex min-w-0 flex-1 items-center gap-2', id !== page && 'hidden')}
            ref={(element) => registerTitleBarSlot(id, 'title', element)}
          />
        ))}
      </div>

      <div className={cn('flex shrink-0 items-center gap-2 px-2', DRAG, SLOT_NO_DRAG)}>
        {TITLE_BAR_PAGES.map((id) => (
          <div
            key={id}
            data-titlebar-auxiliary={id}
            className={cn('flex items-center gap-1', id !== page && 'hidden')}
            ref={(element) => registerTitleBarSlot(id, 'auxiliary', element)}
          />
        ))}
        {page === 'session' && (
          <TitleBarButton label="迷你模式" tooltip="迷你模式" onClick={() => openMiniCard(getCurrentSession())}>
            <PictureInPicture2 />
          </TitleBarButton>
        )}
      </div>
    </header>
  );
}
