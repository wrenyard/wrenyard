import type { StatusTone } from '@/renderer/components/status-badge';

/**
 * Consolidated run/session status mapping shared by the stats and session
 * surfaces. `done` and `completed` intentionally read the same, `queued`
 * reads as waiting, and an unknown-but-present status falls back to its raw
 * value while an absent status reads as the generic task label.
 */
const STATUS_VIEW: Record<string, { tone: StatusTone; label: string }> = {
  running: { tone: 'running', label: '运行中' },
  completed: { tone: 'success', label: '已完成' },
  done: { tone: 'success', label: '已完成' },
  ok: { tone: 'success', label: '成功' },
  success: { tone: 'success', label: '成功' },
  failed: { tone: 'danger', label: '失败' },
  error: { tone: 'danger', label: '失败' },
  exhausted: { tone: 'warning', label: '达到推理上限' },
  interrupted: { tone: 'muted', label: '已中断' },
  cancelled: { tone: 'muted', label: '已取消' },
  aborted: { tone: 'muted', label: '已取消' },
  skipped: { tone: 'muted', label: '已跳过' },
  unavailable: { tone: 'muted', label: '不可用' },
  queued: { tone: 'warning', label: '等待中' },
};

/** Resolve one business status into the tone and label a `StatusBadge` needs. */
export function statusView(status: string | undefined | null): { tone: StatusTone; label: string } {
  if (status === undefined || status === null || status === '') {
    return { tone: 'muted', label: '任务' };
  }
  return STATUS_VIEW[status] ?? { tone: 'muted', label: status };
}
