import { QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/renderer/components/ui/tooltip';
import { AppShell } from '@/renderer/app/AppShell';
import { queryClient } from '@/renderer/app/query-client';

/** Renderer root: data client, tooltip host and the shell frame. */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppShell />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
