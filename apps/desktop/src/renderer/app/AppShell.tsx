import { Activity, Fragment, useEffect, useState } from 'react';
import type { ComponentType, CSSProperties, ReactNode } from 'react';
import type { RemoteConnectionState, ShellPage } from '@/shell-contract';
import { useRemoteConnection, useShellPage } from '@/renderer/lib/desktop';
import { Spinner } from '@/renderer/components/ui/spinner';
import { useMiniMode } from '@/renderer/lib/mini';
import { startViewTransition } from '@/renderer/lib/motion';
import { useIsMobile } from '@/renderer/hooks/use-mobile';
import { Sidebar, SidebarInset, SidebarProvider } from '@/renderer/components/ui/sidebar';
import { AppSidebar } from '@/renderer/app/AppSidebar';
import { ActivityPanel } from '@/renderer/app/ActivityPanel';
import { closeActivityPanel, useActivityPanelState } from '@/renderer/lib/activity-panel';
import { useActivityPanelResize } from '@/renderer/app/useActivityPanelResize';
import { useShellSidebarResize } from '@/renderer/app/useShellSidebarResize';
import { TitleBar } from '@/renderer/app/TitleBar';
import { StatusBar } from '@/renderer/app/statusbar/StatusBar';
import { TitleBarPageProvider } from '@/renderer/lib/titlebar';
import { useShellSidebarFallback } from '@/renderer/lib/navigation';
import { UpdateDialog } from '@/renderer/app/dialogs/UpdateDialog';
import { SessionPage } from '@/renderer/pages/session';
import { WorkspaceGate } from '@/renderer/app/WorkspaceGate';
import { TracePage } from '@/renderer/pages/trace';
import { StatsPage } from '@/renderer/pages/stats';
import { TasksPage } from '@/renderer/pages/tasks';
import { AgentsPage } from '@/renderer/pages/agents';
import { BotPage } from '@/renderer/pages/bot/BotPage';
import { TodoPage } from '@/renderer/pages/todo';
import { SettingsPage } from '@/renderer/pages/settings';

/** Dispatch order for the shell pages; also the first-visit mount order. */
const PAGE_ORDER: readonly ShellPage[] = ['session', 'trace', 'stats', 'tasks', 'agents', 'bot', 'todo', 'settings'];

/** The session page is the only page gated on a usable workspace. */
function WorkspaceGatedSessionPage() {
  return (
    <WorkspaceGate>
      <SessionPage />
    </WorkspaceGate>
  );
}

/**
 * Transition/disconnected overlay for the single active context. While the
 * endpoint is not settled (`connecting`/`disconnected`) the business pages are
 * unmounted rather than left showing the previous host's data, and the copy
 * points the user at the Daemon menu, which stays reachable because this
 * covers only the page area — never the sidebar, title bar or status bar.
 */
function RemoteTransitionNotice({ state, message }: { state: RemoteConnectionState; message?: string }) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground"
      data-remote-transition
    >
      {state === 'connecting' ? <Spinner className="size-5" /> : null}
      <p>{state === 'connecting' ? '正在切换远程连接…' : '远程连接已断开'}</p>
      {message ? <p className="max-w-md text-xs">{message}</p> : null}
      <p className="text-xs">业务页面已暂停；可在左侧 Daemon 菜单中返回本地或重新连接。</p>
    </div>
  );
}

// Settings is dispatched separately: it renders into the shell's left column
// through the portal host, so it needs props the other pages do not.
const PAGES: Record<Exclude<ShellPage, 'settings'>, ComponentType> = {
  session: WorkspaceGatedSessionPage,
  trace: TracePage,
  stats: StatsPage,
  tasks: TasksPage,
  agents: AgentsPage,
  bot: BotPage,
  todo: TodoPage,
};

/**
 * Shell frame: a full-width title bar, the single global sidebar beside the
 * active page, and the full-width status bar, per the window-chrome spec. Each page
 * mounts on first visit and is then kept alive inside an `Activity` boundary,
 * so switching pages preserves state and pauses hidden effects. The title bar
 * is rendered outside the middle row but inside the page provider so portaled
 * headers land in the right slots.
 */
export function AppShell() {
  const page = useShellPage();
  const mini = useMiniMode();
  const connection = useRemoteConnection();
  // Business pages exist only while the active endpoint is committed. A switch
  // in progress or a lost remote tunnel unmounts them, and a committed change
  // remounts them under a generation key so no page-owned state (session
  // selection, drafts, inspector) carries to the other host.
  const endpointSettled = connection.state === 'local' || connection.state === 'remote';
  // The rendered page lags the store by one view transition so the page swap
  // runs inside `document.startViewTransition`; without a transition it follows
  // the store directly.
  const [shown, setShown] = useState<ShellPage>(page);
  const [visited, setVisited] = useState<ReadonlySet<ShellPage>>(() => new Set([page]));
  const [updateOpen, setUpdateOpen] = useState(false);
  // The global sidebar is the shell's own secondary sidebar. It is registered
  // as the Cmd/Ctrl+B fallback target so the title bar can toggle it on pages
  // that own no local sidebar (mini cards have no sidebar to toggle).
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Settings' category column shares the shell left column; its open state is
  // separate from the conversation sidebar's.
  const [settingsSidebarOpen, setSettingsSidebarOpen] = useState(true);
  // Portal host for the settings column, kept mounted so the target persists.
  const [settingsSidebarHost, setSettingsSidebarHost] = useState<HTMLDivElement | null>(null);
  // Mini always shows the session page; other visited pages stay mounted but
  // hidden, so switching back keeps their state.
  const active = mini ? 'session' : shown;
  useShellSidebarFallback({ open: sidebarOpen, setOpen: setSidebarOpen, enabled: !mini });
  // While Settings is active the shell left column is its directory.
  const shellSidebarOpen = active === 'settings' ? settingsSidebarOpen : sidebarOpen;
  // The shell sidebar can be dragged wider or narrower. Resizing applies to the
  // expanded desktop shell only; a collapsed or mobile (sheet) sidebar has no
  // boundary to drag. The width is fed to `SidebarProvider` so the desktop gap
  // and the fixed container move together.
  const isMobile = useIsMobile();
  const sidebarResize = useShellSidebarResize(!mini && shellSidebarOpen && !isMobile);
  // The one app-level activity panel: opened by the status-bar item, the
  // transcript task chip or `activity.toggle`. On a narrow window it overlays
  // the page instead of pushing it narrower than the main-area reserve.
  const activityPanel = useActivityPanelState();
  const activityResize = useActivityPanelResize(!mini && activityPanel.open && !isMobile);
  const [viewportWidth, setViewportWidth] = useState<number>(() => window.innerWidth);
  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const activityInFlow = !mini && !isMobile && viewportWidth - activityResize.width >= 560;

  useEffect(() => {
    if (page === shown) return;
    // Settings reshapes the shell geometry, so it swaps without a view transition.
    if (page === 'settings' || shown === 'settings') {
      setShown(page);
      return;
    }
    startViewTransition(() => setShown(page));
  }, [page, shown]);

  useEffect(() => {
    setVisited((previous) => (previous.has(shown) ? previous : new Set(previous).add(shown)));
  }, [shown]);

  const mounted = mini && !visited.has('session')
    ? new Set(visited).add('session')
    : visited.has(active)
      ? visited
      : new Set(visited).add(active);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-mini={mini ? 'true' : undefined}
      onMouseDown={(event) => {
        // Do not let a mouse click move keyboard focus onto a button: a lingering
        // :focus-visible would show a focus ring, and a later Space press would
        // re-activate the button. Inputs stay untouched so they still focus.
        const target = event.target;
        if (target instanceof Element && target.closest('button, [role="button"]')) {
          event.preventDefault();
        }
      }}
    >
      <TitleBar />
      <div className="relative flex min-h-0 flex-1">
        <SidebarProvider
          className="h-full min-h-0"
          open={shellSidebarOpen}
          onOpenChange={active === 'settings' ? setSettingsSidebarOpen : setSidebarOpen}
          data-shell-resizing={sidebarResize.resizing ? 'true' : undefined}
          style={{ '--sidebar-width': `${sidebarResize.width}px` } as CSSProperties}
        >
          {!mini && (
            <Activity mode={active === 'settings' ? 'hidden' : 'visible'}>
              <AppSidebar page={shown} onOpenUpdate={() => setUpdateOpen(true)} />
            </Activity>
          )}
          {/* Settings directory in the shell left column; hidden but mounted otherwise. */}
          {!mini && (
            <div className={active === 'settings' && settingsSidebarOpen ? 'flex min-h-0 flex-col shrink-0' : 'hidden'}>
              <Sidebar collapsible="none" className="shrink-0 border-r">
                <div ref={setSettingsSidebarHost} className="flex min-h-0 flex-1 flex-col" />
              </Sidebar>
            </div>
          )}
          {!mini && shellSidebarOpen && !isMobile && <div {...sidebarResize.handleProps} />}
          <SidebarInset className="motion-surface-page flex min-h-0 min-w-0 flex-col">
            {endpointSettled ? (
              // Generation-keyed boundary: a committed switch remounts the page
              // tree, so page-owned state cannot leak across hosts.
              <Fragment key={connection.generation}>
                {PAGE_ORDER.map((id) => {
                  if (!mounted.has(id)) return null;
                  let content: ReactNode;
                  if (id === 'settings') {
                    content = (
                      <SettingsPage
                        sidebarHost={settingsSidebarHost}
                        settingsSidebarOpen={settingsSidebarOpen}
                        onSettingsSidebarOpenChange={setSettingsSidebarOpen}
                      />
                    );
                  } else {
                    const PageComponent = PAGES[id];
                    content = <PageComponent />;
                  }
                  return (
                    <Activity key={id} mode={id === active ? 'visible' : 'hidden'}>
                      <TitleBarPageProvider page={id}>
                        <div className="flex min-h-0 flex-1 flex-col">{content}</div>
                      </TitleBarPageProvider>
                    </Activity>
                  );
                })}
              </Fragment>
            ) : (
              <RemoteTransitionNotice state={connection.state} message={connection.message} />
            )}
          </SidebarInset>
          <UpdateDialog open={updateOpen} onOpenChange={setUpdateOpen} />
        </SidebarProvider>
        {!mini && activityPanel.open && (
          activityInFlow ? (
            <>
              <div {...activityResize.handleProps} />
              <aside
                className="flex w-(--activity-panel-width) min-h-0 shrink-0 flex-col border-l bg-background"
                style={{ '--activity-panel-width': `${activityResize.width}px` } as CSSProperties}
                data-activity-panel
              >
                <ActivityPanel scopeSession={activityPanel.scopeSession} />
              </aside>
            </>
          ) : (
            <>
              <div
                className="absolute inset-0 z-30 bg-black/20"
                onMouseDown={() => closeActivityPanel()}
              />
              <aside
                className="absolute inset-y-0 right-0 z-40 flex min-h-0 flex-col border-l bg-background shadow-lg"
                style={{ width: `min(${activityResize.width}px, 100%)` }}
                data-activity-panel
              >
                <ActivityPanel scopeSession={activityPanel.scopeSession} />
              </aside>
            </>
          )
        )}
      </div>
      {!mini && <StatusBar />}
    </div>
  );
}
