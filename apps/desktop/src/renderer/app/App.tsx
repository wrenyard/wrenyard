import { QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/renderer/components/ui/tooltip';
import { ConfirmHost } from '@/renderer/components/confirm-host';
import { Toaster } from '@/renderer/components/ui/sonner';
import { AppShell } from '@/renderer/app/AppShell';
import { queryClient } from '@/renderer/app/query-client';
// Boot the command table and the notification facade (module-load side effects:
// main-process command delivery and the notification-history toast consumer).
import '@/renderer/app/commands';

/** Renderer root: data client, tooltip host, shell frame, confirm and toast hosts. */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppShell />
        <ConfirmHost />
        <Toaster position="bottom-right" visibleToasts={3} offset={{ bottom: 'calc(var(--statusbar-height, 0px) + 8px)' }} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
