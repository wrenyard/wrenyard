import type { ActionKindModel, ContextItem, ItemStatus, Phase, TurnStatus } from './types.js';

/* Central product copy for the session-v2 page. */

export const MAX_CYCLES = 10;

export const PHASE_LABEL: Record<Phase, string> = {
  preparing: '准备上下文',
  reasoning: '推理中',
  acting: '执行行动',
  replying: '撰写回复',
};

export const TURN_STATUS_LABEL: Record<TurnStatus, string> = {
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
  exhausted: '达到推理上限',
};

const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  running: '运行中',
  done: '完成',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已取消',
  aborted: '已取消',
};

export function phaseLabel(phase: Phase): string {
  return PHASE_LABEL[phase];
}

export function turnStatusLabel(status: TurnStatus): string {
  return TURN_STATUS_LABEL[status];
}

export function itemStatusLabel(status: ItemStatus): string {
  return ITEM_STATUS_LABEL[status];
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

export function basename(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index === -1 ? path : path.slice(index + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export interface ActionCopy {
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
