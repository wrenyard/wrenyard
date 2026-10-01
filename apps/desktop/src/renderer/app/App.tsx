import { QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/renderer/components/ui/tooltip';
import { ConfirmHost } from '@/renderer/components/confirm-host';
import { AppShell } from '@/renderer/app/AppShell';
import { queryClient } from '@/renderer/app/query-client';

/** Renderer root: data client, tooltip host, the shell frame, confirm host. */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppShell />
        <ConfirmHost />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
