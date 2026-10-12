import { getSessionBridge } from '@/renderer/lib/session';
import type { SessionBridge } from '@/session/preload';

/** Trace reads the shared session bridge directly, without depending on the session page. */
export function getTraceApi(): SessionBridge {
  return getSessionBridge();
}

export const listSessions = () => getTraceApi().list();
export const readLedger = (sessionId: string) => getTraceApi().ledger(sessionId);
export const subscribeLedger = (listener: Parameters<SessionBridge['onEvent']>[0]) =>
  getTraceApi().onEvent(listener);
