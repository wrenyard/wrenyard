/** Mutable preserve slot registered for a live execution id (see launch + arm). */
export type OwnedRunHomeSessionPreserveSlot = {
  snapshotDir: string;
  sessionId: string;
  preserveTo: string;
};

const preserveSlotByExecutionId = new Map<string, OwnedRunHomeSessionPreserveSlot>();

/** Bind a run-home preserve slot to the execution that owns the child process. */
export function registerRunHomeSessionPreserveSlot(executionId: string, slot: OwnedRunHomeSessionPreserveSlot): void {
  const id = executionId.trim();
  if (!id || id.length > 128 || /[^\w-]/u.test(id)) return;
  preserveSlotByExecutionId.set(id, slot);
}

/** Late-bind the native session id so non-success cleanup can snapshot the run home. */
export function armRunHomeSessionPreserve(executionId: string, clientFamily: string, nativeSessionId: string): void {
  const slot = preserveSlotByExecutionId.get(executionId.trim());
  if (!slot || !nativeSessionId || nativeSessionId.includes('/') || nativeSessionId.includes('\\') || nativeSessionId.includes('\0')) return;
  if (!clientFamily || clientFamily.includes('/') || clientFamily.includes('\\')) return;
  slot.sessionId = nativeSessionId;
  slot.preserveTo = `clients/${clientFamily}/sessions/${nativeSessionId}`;
}

export function clearRunHomeSessionPreserveSlot(executionId: string): void {
  preserveSlotByExecutionId.delete(executionId.trim());
}
