import { getSessionBridge } from '@/renderer/lib/session';

export const listSessions = () => getSessionBridge().list();
export const readLedger = (sessionId: string) => getSessionBridge().ledgerSnapshot(sessionId);
export const subscribeLedger = (listener: Parameters<ReturnType<typeof getSessionBridge>['onEvent']>[0]) =>
  getSessionBridge().onEvent(listener);
