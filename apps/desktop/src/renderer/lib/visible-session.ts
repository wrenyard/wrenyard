/** Synchronous on-screen session id for toast suppression and similar guards. */
let visibleSessionId = '';

export function setVisibleSession(sessionId: string): void {
  visibleSessionId = sessionId;
}

export function getVisibleSessionId(): string {
  return visibleSessionId;
}
