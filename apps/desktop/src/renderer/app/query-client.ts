import { QueryClient } from '@tanstack/react-query';
import {
  onDaemonChanged,
  onPreferencesChanged,
  onQuotaChanged,
  onRemoteChanged,
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

/**
 * Query roots that belong to the Desktop client itself, not to the active
 * daemon endpoint. They survive a connection switch: appearance/UI preferences
 * and the client updater are local concerns and must keep their data even while
 * remote. Everything else is endpoint-bound and is dropped on a switch.
 */
const CLIENT_LOCAL_QUERY_ROOTS = new Set(['preferences', 'update']);

/**
 * Gate newly created queries while a switch is in flight (`connecting`) or a
 * remote tunnel is lost (`disconnected`): a fetch started then would be sent to
 * the previous endpoint or to a dead one. Already-mounted observers are handled
 * by cancelling and dropping their entries below; any refetch they still attempt
 * fails fast because the main process denies business requests while the
 * endpoint is unsettled.
 */
function applyEndpointSettled(settled: boolean): void {
  queryClient.setDefaultOptions({
    queries: {
      ...(queryClient.getDefaultOptions().queries ?? {}),
      enabled: settled,
    },
  });
}

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
  // A successful workspace switch rebinds the daemon's session ledger, so the
  // sidebar must refresh now instead of waiting for its 3-second poll.
  void queryClient.invalidateQueries({ queryKey: ['sessionList'] });
});

onPreferencesChanged(() => {
  void queryClient.invalidateQueries({ queryKey: ['preferences'] });
});

/**
 * The committed connection generation the boundary currently reflects. Every
 * `onRemoteChanged` push carries the generation, so an async handler step that
 * resumes after a newer transition can be recognised as stale and skipped
 * instead of clearing or refetching the wrong context.
 */
let appliedGeneration = -1;

onRemoteChanged((snapshot) => {
  // A push from a superseded switch must not move the boundary backwards.
  if (snapshot.generation < appliedGeneration) return;
  appliedGeneration = snapshot.generation;
  // A committed local↔remote switch changes the active endpoint for every
  // business surface at once. `connecting`/`disconnected` are explicitly *not*
  // settled: nothing may be fetched against a half-open or lost endpoint.
  const settled = snapshot.state === 'local' || snapshot.state === 'remote';
  applyEndpointSettled(settled);
  // Cancel in-flight reads before dropping their entries: a reply already on
  // the wire belongs to the previous endpoint and must not be written into a
  // cache that now describes a different one. Invalidation alone would leave
  // that reply's result visible until the refetch landed.
  void queryClient.cancelQueries().then(() => {
    // A newer transition superseded this handler while the cancel was pending:
    // leave the caches to that transition's handler rather than acting here.
    if (snapshot.generation !== appliedGeneration) return;
    queryClient.removeQueries({
      predicate: (query) => !CLIENT_LOCAL_QUERY_ROOTS.has(String(query.queryKey[0])),
    });
    if (settled) {
      // The committed context is authoritative now, so refetch every
      // endpoint-bound view (session, task, project, provider, quota,
      // statistics, Pet) from the new endpoint. The main process has already
      // reset the session selection and draft.
      void queryClient.invalidateQueries();
    }
  });
});
