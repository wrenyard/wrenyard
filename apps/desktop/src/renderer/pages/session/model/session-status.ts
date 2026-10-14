/**
 * Pure derivation of a session's status dot. One module, no React: the session
 * list, the search dialog and the mini-card title bar all call
 * `sessionStatusOf` and hand the result to `SessionDot`.
 */
import type { SessionSummary } from '@wrenyard/session';
import type { SessionSeenState } from '@/session/preload';

/** The five dot states, in display priority order. */
export type SessionStatusKind = 'working' | 'attention' | 'error' | 'unread' | 'idle';

export interface SessionStatus {
  kind: SessionStatusKind;
  /** Hover text; absent only for `idle`. */
  tooltip?: string;
}

/**
 * Failure-kind labels matching the product copy in `describe.ts`. That module
 * keeps its label tables private and this module must stay free of page
 * imports, so the mapping is mirrored here; the fallback stays `出错`.
 */
const ERROR_KIND_LABEL: Record<string, string> = {
  rate_limited: '限流',
  quota_exhausted: '额度耗尽',
  auth_failed: '认证失败',
  auth: '认证失败',
  model_unavailable: '模型不可用',
  network: '连接错误',
  server: '服务端错误',
  invalid_request: '非法请求',
  context_overflow: '上下文超限',
  protocol: '协议错误',
  interrupted: '输出中断',
  aborted: '已取消',
};

const ERROR_MESSAGE_MAX = 80;

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

function errorTooltip(lastTurn: NonNullable<SessionSummary['lastTurn']>): string {
  const label = lastTurn.errorKind === undefined
    ? '出错'
    : (ERROR_KIND_LABEL[lastTurn.errorKind] ?? '出错');
  let tooltip = label;
  const message = lastTurn.errorMessage?.split('\n', 1)[0]?.trim() ?? '';
  if (message !== '') tooltip += `：${truncate(message, ERROR_MESSAGE_MAX)}`;
  if (lastTurn.retryAt !== undefined) {
    const retry = Date.parse(lastTurn.retryAt);
    if (Number.isFinite(retry) && retry > Date.now()) {
      const at = new Date(retry);
      tooltip += ` · 约 ${pad2(at.getHours())}:${pad2(at.getMinutes())} 恢复`;
    }
  }
  return tooltip;
}

/**
 * Derive one session's dot state and hover text. Priority: working > attention
 * > error > unread > idle. `seen` null means the snapshot is not loaded yet, so
 * nothing is unread.
 */
export function sessionStatusOf(summary: SessionSummary, seen: SessionSeenState | null): SessionStatus {
  if (summary.running === true) return { kind: 'working', tooltip: '运行中' };
  const lastTurn = summary.lastTurn;
  if (lastTurn?.needsUser === true) {
    return { kind: 'attention', tooltip: lastTurn.label ?? '等你回复' };
  }
  if (lastTurn?.status === 'failed') {
    return { kind: 'error', tooltip: errorTooltip(lastTurn) };
  }
  if (lastTurn?.status === 'completed' && seen !== null) {
    const seenAt = seen.seen[summary.sessionId] ?? seen.baselineAt;
    if (lastTurn.finishedAt > seenAt) return { kind: 'unread', tooltip: '有新结果' };
  }
  return { kind: 'idle' };
}
