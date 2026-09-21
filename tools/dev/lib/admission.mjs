/** User-facing recovery hint when source-dev leaves or finds a frozen dispatcher. */
export const DISPATCH_THAW_HINT = [
  '当前 daemon 派发已冻结，不会接受新任务。',
  '若这是你手动冻结的，请保持。若是 pnpm dev 交接残留，可执行：wrenyard daemon thaw',
].join('\n');

export function shouldAutoThaw(token) {
  return Boolean(token?.froze && token.originalMode === 'accepting');
}

export function dispatchBlocksNewWork(health) {
  const dispatch = health && typeof health === 'object' ? health.dispatch : undefined;
  if (!dispatch || typeof dispatch !== 'object') {
    return { known: false, blocked: true, reason: 'cannot confirm dispatch admission' };
  }
  if (dispatch.recovery_required === true) {
    return { known: true, blocked: true, reason: 'daemon recovery is required' };
  }
  if (dispatch.mode === 'planned_restart') {
    return { known: true, blocked: true, reason: 'a planned restart is active' };
  }
  if (dispatch.mode === 'frozen' || dispatch.frozen === true || dispatch.accepting === false) {
    return { known: true, blocked: true, reason: 'dispatch is frozen' };
  }
  if (dispatch.mode !== 'accepting') {
    return { known: false, blocked: true, reason: `dispatch mode is ${dispatch.mode ?? 'unknown'}` };
  }
  return { known: true, blocked: false };
}

export function dispatchIsAccepting(health) {
  const state = dispatchBlocksNewWork(health);
  return state.known && !state.blocked;
}
