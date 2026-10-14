/**
 * Electron-free workspace activation helpers. A workspace change is applied by
 * the daemon's own idle-only `workspace.switch` method, which rebinds every
 * workspace-scoped service while the same daemon process keeps running. The
 * switch is only safe when the daemon has no queued or running work, so
 * activation first asserts an idle daemon and never interrupts in-flight tasks.
 * The daemon is the authority on the outcome: Desktop surfaces its busy or
 * shutting-down reason verbatim instead of restarting anything itself.
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
  if (state.shutting_down === true) {
    return { idle: false, reason: 'Daemon 正在重启，请稍后再切换工作区' };
  }
  if (state.idle !== true || counts.some((key) => (state[key] as number) > 0)) {
    return { idle: false, reason: '后台仍有任务或正在维护，请完成后再切换工作区' };
  }
  return { idle: true };
}
