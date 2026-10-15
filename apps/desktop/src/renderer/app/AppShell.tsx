import { Activity, useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import type { ShellPage } from '@/shell-contract';
import { useShellPage } from '@/renderer/lib/desktop';
import { useMiniMode } from '@/renderer/lib/mini';
import { startViewTransition } from '@/renderer/lib/motion';
import { SidebarInset, SidebarProvider } from '@/renderer/components/ui/sidebar';
import { AppSidebar } from '@/renderer/app/AppSidebar';
import { TitleBar } from '@/renderer/app/TitleBar';
import { StatusBar } from '@/renderer/app/statusbar/StatusBar';
import { TitleBarPageProvider } from '@/renderer/lib/titlebar';
import { useShellSidebarFallback } from '@/renderer/lib/navigation';
import { UpdateDialog } from '@/renderer/app/dialogs/UpdateDialog';
import { SessionPage } from '@/renderer/pages/session';
import { WorkspaceGate } from '@/renderer/app/WorkspaceGate';
import { TracePage } from '@/renderer/pages/trace';
import { StatsPage } from '@/renderer/pages/stats';
import { QuotaPage } from '@/renderer/pages/quota';
import { TasksPage } from '@/renderer/pages/tasks';
import { SchedulesPage } from '@/renderer/pages/schedules';
import { SettingsPage } from '@/renderer/pages/settings';

/** Dispatch order for the shell pages; also the first-visit mount order. */
const PAGE_ORDER: readonly ShellPage[] = ['session', 'trace', 'stats', 'quota', 'tasks', 'schedules', 'settings'];

/** The session page is the only page gated on a usable workspace. */
function WorkspaceGatedSessionPage() {
  return (
    <WorkspaceGate>
      <SessionPage />
    </WorkspaceGate>
  );
}

const PAGES: Record<ShellPage, ComponentType> = {
  session: WorkspaceGatedSessionPage,
  trace: TracePage,
  stats: StatsPage,
  quota: QuotaPage,
  tasks: TasksPage,
  schedules: SchedulesPage,
  settings: SettingsPage,
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
  useShellSidebarFallback({ open: sidebarOpen, setOpen: setSidebarOpen, enabled: !mini });

  useEffect(() => {
    if (page === shown) return;
    startViewTransition(() => setShown(page));
  }, [page, shown]);

  useEffect(() => {
    setVisited((previous) => (previous.has(shown) ? previous : new Set(previous).add(shown)));
  }, [shown]);

  // Mini always shows the session page; other visited pages stay mounted but
  // hidden, so switching back keeps their state.
  const active = mini ? 'session' : shown;
  const mounted = mini && !visited.has('session') ? new Set(visited).add('session') : visited;

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
      <div className="flex min-h-0 flex-1">
        <SidebarProvider
          className="h-full min-h-0"
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
        >
          {!mini && (
            <Activity mode={active === 'settings' ? 'hidden' : 'visible'}>
              <AppSidebar page={shown} onOpenUpdate={() => setUpdateOpen(true)} />
            </Activity>
          )}
          <SidebarInset className="motion-surface-page flex min-h-0 min-w-0 flex-col">
            {PAGE_ORDER.map((id) => {
              if (!mounted.has(id)) return null;
              const PageComponent = PAGES[id];
              return (
                <Activity key={id} mode={id === active ? 'visible' : 'hidden'}>
                  <TitleBarPageProvider page={id}>
                    <div className="flex min-h-0 flex-1 flex-col">
                      <PageComponent />
                    </div>
                  </TitleBarPageProvider>
                </Activity>
              );
            })}
          </SidebarInset>
          <UpdateDialog open={updateOpen} onOpenChange={setUpdateOpen} />
        </SidebarProvider>
      </div>
      {!mini && <StatusBar />}
    </div>
  );
}
