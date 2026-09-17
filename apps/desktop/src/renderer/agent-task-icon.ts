export type AgentTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';

export function createAgentTaskStatusIcon(status: AgentTaskStatus | string | undefined): HTMLSpanElement {
  const icon = document.createElement('span');
  const normalized = status === 'done' ? 'done'
    : status === 'running' ? 'running'
      : status === 'queued' ? 'queued'
        : status === 'cancelled' ? 'cancelled'
          : status === 'interrupted' ? 'interrupted'
            : status === 'failed' ? 'error'
          : 'unknown';
  icon.className = `agent-task-status-icon is-${normalized}`;
  icon.setAttribute('role', 'img');
  const label = { done: '已完成', running: '运行中', queued: '等待中', error: '失败', cancelled: '已取消', interrupted: '已中断', unknown: '任务' }[normalized];
  icon.setAttribute('aria-label', label);
  icon.title = label;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 3v3M8 3h8M6 6h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2ZM8 11v2m8-2v2M9 17h6M1 11v5m22-5v5');
  svg.append(path);
  icon.append(svg);
  return icon;
}
