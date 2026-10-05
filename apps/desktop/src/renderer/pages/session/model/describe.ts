import type { TimelineTone } from '@/renderer/components/timeline-bars';
import type { ActionModel, CallModel, ContextItem, LedgerEvent, Phase, TurnModel } from './types.js';

/* Central product copy and mappings for the session page. */


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
  reason: '主推理',
  'memory-search': '记忆检索',
  'doc-search': '文档检索',
  compile: '派发编译',
  reply: '沟通',
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

/** Unified status label, shared with the stats surface (see lib/task-status). */
export { statusView } from '@/renderer/lib/task-status';

export function phaseLabel(phase: Phase): string {
  return PHASE_DETAIL_LABEL[phase];
}

/** `第 N 次推理`. */
export function cycleLabel(index: number): string {
  return `第 ${index} 次推理`;
}

/**
 * One-line status for a running turn, shown under the streaming assistant
 * message. Kept exact so the page, the inspector and screenshots agree.
 */
export function turnStatusText(turn: TurnModel): string {
  if (turn.interrupting) return '正在中断…';
  switch (turn.phase) {
    case 'reasoning':
      return `第 ${Math.max(1, turn.cycle)} 次推理…`;
    case 'acting': {
      const running = turn.actions.filter((action) => action.status === 'running');
      if (running.length === 1) return `执行 ${running[0]!.title}…`;
      if (running.length > 1) return `执行 ${running.length} 个行动…`;
      return '执行行动…';
    }
    case 'replying':
      return '撰写回复…';
    case 'preparing':
    default:
      return '准备上下文…';
  }
}

export interface NoFinalReply {
  /** Exact product copy for an ended turn without a final reply. */
  text: string;
  /** `destructive` renders plain error text; `outline` renders a bubble. */
  variant: 'destructive' | 'outline';
}

function summarizeError(message: string, max = 60): string {
  const line = (message.split('\n', 1)[0] ?? '').trim();
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : line;
}

/** Fallback assistant line for an ended turn that produced no final reply. */
export function noFinalReply(turn: TurnModel): NoFinalReply {
  if (turn.status === 'failed') {
    return { text: `出错了：${summarizeError(turn.errors[0]?.message ?? '未知错误')}`, variant: 'destructive' };
  }
  if (turn.status === 'interrupted') return { text: '已中断', variant: 'outline' };
  if (turn.status === 'exhausted') return { text: '达到推理上限，没有给出回复', variant: 'outline' };
  return { text: '没有给出回复', variant: 'outline' };
}

function basename(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index === -1 ? path : path.slice(index + 1);
}

/** File name without directory and extension. */
export function shortName(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Display label for one action: `title · taskDisplayName` when both exist,
 * else the title, else the task display name, else — for read/write — the
 * first 20 characters of the intent.
 */
export function actionLabel(action: {
  title?: string;
  taskDisplayName?: string;
  task?: string;
  kind: string;
  intent: string;
}): string {
  const title = action.title?.trim() ?? '';
  const taskDisplayName = action.taskDisplayName?.trim() ?? '';
  if (title !== '' && taskDisplayName !== '') return `${title} · ${taskDisplayName}`;
  if (title !== '') return title;
  if (taskDisplayName !== '') return taskDisplayName;
  if (action.kind === 'read' || action.kind === 'write') {
    return [...action.intent].slice(0, 20).join('');
  }
  return '';
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
    case 'thinking': return oneLine(String(record.text ?? ''));
    case 'doc.search': return oneLine(String(record.understanding ?? ''));
    case 'doc.content': return `${record.format} · ${record.path}`;
    case 'files': return `${record.source} · ${Array.isArray(record.files) ? record.files.length : 0} 个文件`;
    case 'memory.recalled': return String(record.path ?? '');
    case 'reason.completed':
    case 'title': return oneLine(String(record.text ?? ''));
    case 'reply': return oneLine(String(record.text ?? ''));
    case 'action.started': return String(record.kind ?? '');
    case 'action.titled': return oneLine(String(record.title ?? ''));
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
