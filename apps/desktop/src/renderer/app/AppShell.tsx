import { Activity, useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ShellPage } from '@/shell-contract';
import { useShellPage } from '@/renderer/lib/desktop';
import { SidebarInset, SidebarProvider } from '@/renderer/components/ui/sidebar';
import { AppSidebar } from '@/renderer/app/AppSidebar';
import { UpdateDialog, isUpdateVisible } from '@/renderer/app/dialogs/UpdateDialog';
import { updateQuery } from '@/renderer/lib/queries';
import { SessionPage } from '@/renderer/pages/session';
import { StatsPage } from '@/renderer/pages/stats';
import { QuotaPage } from '@/renderer/pages/quota';
import { TasksPage } from '@/renderer/pages/tasks';
import { SettingsPage } from '@/renderer/pages/settings';

/** Dispatch order for the shell pages; also the first-visit mount order. */
const PAGE_ORDER: readonly ShellPage[] = ['session', 'stats', 'quota', 'tasks', 'settings'];

const PAGES: Record<ShellPage, ComponentType> = {
  session: SessionPage,
  stats: StatsPage,
  quota: QuotaPage,
  tasks: TasksPage,
  settings: SettingsPage,
};

/**
 * Shell frame: a fixed, always-collapsed activity rail beside the active page.
 * Each page mounts on first visit and is then kept alive inside an `Activity`
 * boundary, so switching pages preserves state and pauses hidden effects.
 */
export function AppShell() {
  const page = useShellPage();
  const [visited, setVisited] = useState<ReadonlySet<ShellPage>>(() => new Set([page]));
  const [updateOpen, setUpdateOpen] = useState(false);
  const update = useQuery(updateQuery);

  useEffect(() => {
    setVisited((previous) => (previous.has(page) ? previous : new Set(previous).add(page)));
  }, [page]);

  return (
    <SidebarProvider
      className="h-full min-h-0"
      open={false}
      // The outer rail is fixed; Cmd+B must only toggle a page's inner sidebar.
      onOpenChange={() => {}}
    >
      <AppSidebar
        page={page}
        updateVisible={isUpdateVisible(update.data)}
        onOpenUpdate={() => setUpdateOpen(true)}
      />
      <SidebarInset className="flex min-h-0 flex-col">
        {PAGE_ORDER.map((id) => {
          if (!visited.has(id)) return null;
          const PageComponent = PAGES[id];
          return (
            <Activity key={id} mode={id === page ? 'visible' : 'hidden'}>
              <div className="flex min-h-0 flex-1 flex-col">
                <PageComponent />
              </div>
            </Activity>
          );
        })}
      </SidebarInset>
      <UpdateDialog open={updateOpen} onOpenChange={setUpdateOpen} />
    </SidebarProvider>
  );
}
