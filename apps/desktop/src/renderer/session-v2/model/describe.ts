import type { StatusTone } from '@/renderer/components/status-badge';
import type { TimelineTone } from '@/renderer/components/timeline-bars';
import type { ActionKindModel, ActionModel, CallModel, ContextItem, LedgerEvent, Phase } from './types.js';

/* Central product copy and mappings for the session page. */

export const MAX_CYCLES = 10;

/** Short phase names for compact lane and section labels. */
export const PHASE_LABEL: Record<Phase, string> = {
  preparing: '准备',
  reasoning: '推理',
  acting: '行动',
  replying: '回复',
};

/** Longer phase names for the work-process header. */
const PHASE_DETAIL_LABEL: Record<Phase, string> = {
  preparing: '准备上下文',
  reasoning: '推理中',
  acting: '执行行动',
  replying: '撰写回复',
};

/** Phase colour tone for the mini phase bar and the timeline phase lane. */
export const PHASE_TONE: Record<Phase, TimelineTone> = {
  preparing: 'muted',
  reasoning: 'primary',
  acting: 'success',
  replying: 'warning',
};

/** Display name of every model call role. */
export const CALL_ROLE_LABEL: Record<CallModel['role'], string> = {
  reason: '推理',
  select: '选择',
  interpret: '解析',
  compile: '编译',
  write: '写文档',
  reply: '回复',
  title: '标题',
};

/** Timeline tone of every action status. */
export const ACTION_TONE: Record<ActionModel['status'], TimelineTone> = {
  running: 'primary',
  done: 'success',
  failed: 'danger',
  skipped: 'muted',
  cancelled: 'muted',
  aborted: 'muted',
};

/** Unified status tone and label across turns, actions, calls and tasks. */
const STATUS_VIEW: Record<string, { tone: StatusTone; label: string }> = {
  running: { tone: 'running', label: '运行中' },
  completed: { tone: 'success', label: '已完成' },
  done: { tone: 'success', label: '完成' },
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
};

/** Resolve one business status into the tone and label a `StatusBadge` needs. */
export function statusView(status: string): { tone: StatusTone; label: string } {
  return STATUS_VIEW[status] ?? { tone: 'muted', label: status };
}

export function phaseLabel(phase: Phase): string {
  return PHASE_DETAIL_LABEL[phase];
}

/** `第 N 次推理`, with the near-limit hint once N reaches 8. */
export function cycleLabel(index: number): string {
  return index >= 8 ? `第 ${index} 次推理（上限 ${MAX_CYCLES}）` : `第 ${index} 次推理`;
}

export const CYCLE_LIMIT_TOOLTIP = `每个轮次最多 ${MAX_CYCLES} 次推理`;

const DOC_TYPE_LABEL: Record<string, string> = {
  spec: '规格文档',
  plan: '计划文档',
  report: '报告',
  handoff: '交接文档',
};

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function basename(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index === -1 ? path : path.slice(index + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface ActionCopy {
  title: string;
  subtitle?: string;
}

/** Title and subtitle for one action, keyed off its parsed payload. */
export function describeAction(kind: ActionKindModel, parsed: unknown, result: string | undefined): ActionCopy {
  const payload = isRecord(parsed) ? parsed : undefined;
  switch (kind) {
    case 'dispatch': {
      const task = typeof payload?.task === 'string' ? payload.task : '任务';
      const project = typeof payload?.project === 'string' ? payload.project : undefined;
      const goal = typeof payload?.goal === 'string' ? payload.goal : '';
      return {
        title: project ? `${task} · ${project}` : task,
        ...(goal ? { subtitle: firstLine(goal) } : {}),
      };
    }
    case 'read': {
      const paths = Array.isArray(payload?.paths) ? payload.paths.filter((p): p is string => typeof p === 'string') : [];
      return {
        title: `读取 ${paths.length} 份资料`,
        ...(paths.length > 0 ? { subtitle: paths.map(basename).join('、') } : {}),
      };
    }
    case 'write-doc': {
      const project = typeof payload?.project === 'string' ? payload.project : undefined;
      const docType = typeof payload?.docType === 'string' ? DOC_TYPE_LABEL[payload.docType] ?? payload.docType : '文档';
      const path = typeof payload?.path === 'string' ? payload.path : undefined;
      return { title: `撰写${docType}`, subtitle: path ?? project };
    }
    case 'unsupported':
      return { title: '无法执行', ...(result ? { subtitle: firstLine(result) } : {}) };
    case 'parse-failed':
      return { title: '解析失败', ...(result ? { subtitle: firstLine(result) } : {}) };
  }
}

export function materialTitle(item: ContextItem): string {
  return item.title && item.title.trim() !== '' ? item.title : basename(item.path);
}

export function ledgerEventType(event: LedgerEvent): string {
  return (event as { type: string }).type;
}

function oneLine(value: string, max = 140): string {
  const line = value.split('\n', 1)[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function summarizeLedgerEvent(event: LedgerEvent): string {
  const record = event as unknown as Record<string, unknown>;
  switch (ledgerEventType(event)) {
    case 'session.created': return String(record.workspaceRoot ?? '');
    case 'turn.started': return oneLine(String(record.text ?? ''));
    case 'context.selected': return `${(record.selections as unknown[] | undefined)?.length ?? 0} 项`;
    case 'memory.recalled':
    case 'doc.read': return String(record.path ?? '');
    case 'reason.completed':
    case 'action.block':
    case 'reply':
    case 'title': return oneLine(String(record.text ?? ''));
    case 'action.started': return String(record.kind ?? '');
    case 'action.finished': return oneLine(`${record.kind} · ${record.status}: ${record.result ?? ''}`);
    case 'ws.updated': return `${record.change} ${record.path}`;
    case 'turn.interrupted': return String(record.reason ?? '');
    case 'turn.finished': return String(record.status ?? '');
    case 'call': return `${record.role} · ${record.model} · ${record.status}`;
    case 'call.started': return `${record.role} · ${record.model}`;
    case 'error': return oneLine(`${record.stage}: ${record.message}`);
    default: return '';
  }
}
