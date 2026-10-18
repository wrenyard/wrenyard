import type { LedgerEvent } from '@wrenyard/session';
import type { TimelineTone } from '@/renderer/components/timeline-bars';
import type { ActionModel, CallModel, ContextItem, Phase, TurnModel } from './types.js';

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

/**
 * Short label of the implementation (task-run) phase. A dispatch whose task run
 * is executing is shown with this label and its own elapsed time, never as the
 * compile stage that produced its input.
 */
export const TASK_RUN_PHASE_LABEL = '实施中';

/** The running dispatch action whose task run has already opened, if any. */
export function runningTaskAction(turn: TurnModel): ActionModel | undefined {
  return turn.actions.find(
    (action) => action.kind === 'dispatch' && action.status === 'running' && action.taskRunId !== undefined,
  );
}

/** Display name of every model call role. */
export const CALL_ROLE_LABEL: Record<CallModel['role'], string> = {
  reason: '主推理',
  'memory-search': '记忆检索',
  search: '检索',
  dispatch: '派发',
  reply: '沟通',
  title: '标题',
  document: '文档',
  vcs: '工作区版本',
  project: '项目',
  schedule: '定时任务',
  status: '状态',
  suggestion: '输入建议',
};

const ROUTE_STATE_LABEL: Record<string, string> = {
  rate_limited: '限流',
  quota_exhausted: '额度耗尽',
  auth_failed: '认证失败',
  model_unavailable: '模型不可用',
};

/** Display name of every normalized transport failure kind. */
const CALL_ERROR_LABEL: Record<string, string> = {
  network: '连接错误',
  server: '服务端错误',
  rate_limited: '限流',
  quota_exhausted: '额度耗尽',
  auth: '认证失败',
  model_unavailable: '模型不可用',
  invalid_request: '非法请求',
  context_overflow: '上下文超限',
  protocol: '协议错误',
  interrupted: '输出中断',
  aborted: '已取消',
  // Local cuts the session made itself, never an upstream fault: the caller's
  // exhausted budget and the local idle deadline keep their own labels instead
  // of falling back to 连接错误 or 已取消.
  local_budget: '预算耗尽',
  local_deadline: '本地超时',
};

function failureLabel(kind: string, status: number | undefined): string {
  const name = CALL_ERROR_LABEL[kind] ?? kind;
  return status === undefined ? name : `${name} ${status}`;
}

/**
 * Transcript chips for a span's route selection and retry record: rank, retry
 * count and reason, and the terminal failure. The rank and retry facts arrive
 * on the span's request and transport metrics; the fold copies them onto the
 * call model.
 */
export function callRouteChips(call: CallModel): string[] {
  const chips: string[] = [];
  if (call.selectedRank !== undefined) chips.push(`排名 ${call.selectedRank}`);
  const retries = call.retries ?? [];
  if (retries.length > 0) chips.push(`重试 ${retries.length} 次`);
  const retry = retries.at(-1);
  if (retry !== undefined) chips.push(`重试原因：${failureLabel(retry.kind, retry.status)}`);
  if (call.error !== undefined) chips.push(`失败：${call.error}`);
  return chips;
}

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
 * message. Kept exact so both session views and screenshots agree.
 */
export function turnStatusText(turn: TurnModel): string {
  if (turn.interrupting) return '正在中断…';
  switch (turn.phase) {
    case 'reasoning':
      return `第 ${Math.max(1, turn.cycle)} 次推理…`;
    case 'acting': {
      const running = turn.actions.filter((action) => action.status === 'running');
      if (running.length === 1) {
        const action = running[0]!;
        // A dispatch is only executing once its task run exists; before that it
        // is still being prepared, so say so instead of claiming execution.
        if (action.kind === 'dispatch') {
          return action.taskRunId === undefined
            ? `准备任务 ${action.title}…`
            : `执行任务 ${action.title}…`;
        }
        return `执行 ${action.title}…`;
      }
      if (running.length > 1) {
        const preparing = running.every(
          (action) => action.kind === 'dispatch' && action.taskRunId === undefined,
        );
        if (preparing) return `准备 ${running.length} 个任务…`;
        return `执行 ${running.length} 个行动…`;
      }
      return '执行行动…';
    }
    case 'replying':
      return '撰写回复…';
    case 'preparing':
    default:
      return '准备上下文…';
  }
}

/**
 * The live recovery waiting state of one turn, projected from its
 * `turn.waiting` event. `retryAt` is optional so a wait without a real expected
 * time stays explicitly unknown rather than borrowing a fallback recheck delay.
 */
export type TurnWaitingState = Pick<Extract<LedgerEvent, { type: 'turn.waiting' }>, 'reason' | 'retryAt'>;

/** Short phase name for the waiting lane, alongside the existing phase labels. */
export const WAITING_PHASE_LABEL = '等待恢复';

/** Chinese label for why the active turn is waiting for recovery. */
export const WAITING_REASON_LABEL: Record<TurnWaitingState['reason'], string> = {
  admission: '等待线路允许探测',
  recovery: '等待线路恢复',
};

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * Chinese status for a turn waiting for recovery, distinct from generating,
 * stalled and error-correction states: the real local next-attempt time when
 * one is known, otherwise an explicit unknown. A fallback recheck delay is
 * never presented as the expected recovery time, and the turn stays
 * interruptible.
 */
export function waitingStatusText(state: TurnWaitingState): string {
  const parsed = state.retryAt === undefined ? Number.NaN : Date.parse(state.retryAt);
  if (!Number.isFinite(parsed)) return '正在等待恢复，预计重试时间：未知';
  const at = new Date(parsed);
  return `正在等待恢复，预计 ${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())} 重试`;
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

/**
 * Terminal state of a turn's dispatch, told apart in the UI: `compile-failed`
 * when the dispatch stopped in the compile stage without opening any task run,
 * `not-started` when a run was opened but the implementation never settled, and
 * `failed`/`ended` for a run that executed.
 */
export type DispatchTerminal = 'compile-failed' | 'not-started' | 'failed' | 'ended';

/** Display label of every dispatch terminal state. */
export const DISPATCH_TERMINAL_LABEL: Record<DispatchTerminal, string> = {
  'compile-failed': '编译失败',
  'not-started': '实施未启动',
  failed: '失败',
  ended: '已结束',
};

/**
 * Classify an ended turn's dispatch outcome. Undefined while the turn still
 * runs: only a turned-ended dispatch has a terminal state. A dispatch that never
 * opened a task run stopped in the compile stage, so it can never be shown as a
 * finished implementation.
 */
export function dispatchTerminal(turn: TurnModel): DispatchTerminal | undefined {
  if (turn.status === 'running') return undefined;
  if (turn.status === 'completed') return 'ended';
  const dispatches = turn.actions.filter((action) => action.kind === 'dispatch');
  if (dispatches.length === 0) return 'failed';
  if (dispatches.every((action) => action.taskRunId === undefined)) {
    return turn.status === 'failed' ? 'compile-failed' : 'not-started';
  }
  return turn.status === 'failed' ? 'failed' : 'not-started';
}

/** Fallback assistant line for an ended turn that produced no final reply. */
export function noFinalReply(turn: TurnModel): NoFinalReply {
  if (turn.status === 'failed') {
    return { text: `出错了：${summarizeError(turn.errors[0]?.message ?? '未知错误')}`, variant: 'destructive' };
  }
  if (turn.status === 'interrupted') return { text: '已中断', variant: 'outline' };
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
  if (action.kind === 'search' || action.kind === 'document') {
    return [...action.intent].slice(0, 20).join('');
  }
  return '';
}

export function materialTitle(item: ContextItem): string {
  return item.title && item.title.trim() !== '' ? item.title : basename(item.path);
}
