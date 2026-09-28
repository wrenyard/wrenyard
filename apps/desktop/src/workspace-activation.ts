/**
 * Electron-free workspace activation helpers. Desktop binds a workspace and
 * restarts the daemon it owns through the shared supervisor. The restart is
 * only safe when the daemon has no queued or running work, so activation first
 * asserts an idle daemon and never interrupts in-flight tasks.
 */

export interface ProductDaemonIdleResult {
  idle: boolean;
  reason?: string;
}

/**
 * Require the real daemon.status contract. The daemon reports idleness directly
 * (`idle`), so activation reads that flag plus the active counts and the
 * shutdown state; missing state is not proof of idle.
 */
export function assertDaemonIdle(rawStatus: unknown): ProductDaemonIdleResult {
  const state = rawStatus && typeof rawStatus === 'object'
    ? rawStatus as Record<string, unknown> : {};
  const counts = ['activeTaskCount', 'activeWorkflowCount', 'activeExecutionCount'];
  if (state.ok !== true || typeof state.idle !== 'boolean' || typeof state.shutting_down !== 'boolean'
    || counts.some((key) => !Number.isSafeInteger(state[key]) || (state[key] as number) < 0)) {
    return { idle: false, reason: '无法确认后台状态，请刷新后重试' };
  }
  if (state.idle !== true || state.shutting_down === true || counts.some((key) => (state[key] as number) > 0)) {
    return { idle: false, reason: '后台仍有任务或正在维护，请完成后再切换工作区' };
  }
  return { idle: true };
}

/**
 * The owner that restarts the daemon after a workspace change. Desktop passes
 * its `DesktopDaemonSupervisor`, but the module stays Electron-free: it only
 * needs the `restart` behaviour.
 */
export interface OwnedDaemonRestart {
  restart(): Promise<{ state: string }>;
}

/**
 * Reactivate the daemon after a workspace change by calling the injected
 * owner's restart. The daemon is always restarted by whoever owns it (Desktop
 * or the source supervisor); activation never shells out to the removed
 * `wrenyard daemon restart` CLI command.
 */
export async function restartOwnedDaemon(owner: OwnedDaemonRestart): Promise<void> {
  const result = await owner.restart();
  if (result.state !== 'running') throw new Error('daemon 未能完成重启，请检查后台状态。');
}
