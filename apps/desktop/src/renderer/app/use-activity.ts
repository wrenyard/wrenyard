import { useQuery } from '@tanstack/react-query';
import { getSessionBridge } from '@/renderer/lib/session';
import { fold } from '@/renderer/pages/session/model/fold';

/** Read snapshots without replacing the conversation page's live subscription. */
export function useSessionActivity() {
  return useQuery({
    queryKey: ['session-activity'],
    queryFn: async () => {
      const bridge = getSessionBridge();
      const sessions = (await bridge.list()).filter((session) => session.running);
      return Promise.all(sessions.map(async (session) => ({
        ...session,
        turns: fold(await bridge.ledgerSnapshot(session.sessionId), [], {}, { sessionId: session.sessionId })
          .turns.filter((turn) => turn.status === 'running'),
      })));
    },
    refetchInterval: 2_000,
  });
}

export function useActivityTaskDetails(taskRunIds: string[]) {
  return useQuery({
    queryKey: ['activity-task-details', taskRunIds],
    queryFn: () => getSessionBridge().tasks(taskRunIds),
    enabled: taskRunIds.length > 0,
    refetchInterval: 2_000,
  });
}
