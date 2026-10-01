import { QueryClient } from '@tanstack/react-query';
import {
  onDaemonChanged,
  onNotificationsChanged,
  onQuotaChanged,
  onUpdateChanged,
} from '@/renderer/lib/desktop';

/**
 * Single renderer query client. Queries retry once and refetch when the window
 * regains focus; bridge pushes invalidate the affected keys exactly once, at
 * module load, rather than per component.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

onUpdateChanged(() => {
  void queryClient.invalidateQueries({ queryKey: ['update'] });
});

onQuotaChanged(() => {
  void queryClient.invalidateQueries({ queryKey: ['quota'] });
});

onDaemonChanged(() => {
  void queryClient.invalidateQueries({ queryKey: ['daemon'] });
  // Settings are daemon-owned, so a daemon change also refreshes them.
  void queryClient.invalidateQueries({ queryKey: ['shell', 'settings'] });
});

onNotificationsChanged(() => {
  void queryClient.invalidateQueries({ queryKey: ['notifications'] });
});
