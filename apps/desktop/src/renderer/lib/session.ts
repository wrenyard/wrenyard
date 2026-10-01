/** Shared typed session facade used by the session page and its settings. */
import type { SessionBridge } from '@/session/preload';

export function getSessionBridge(): SessionBridge {
  return window.wrenyardSession;
}
