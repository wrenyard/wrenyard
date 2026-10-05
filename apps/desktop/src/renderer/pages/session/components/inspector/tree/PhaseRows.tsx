import { useState, type ReactNode } from 'react';
import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import { AppMarkdown as Markdown } from '@/renderer/components/app-markdown';
import { Reasoning } from '@/renderer/components/chat/reasoning';
import { Button } from '@/renderer/components/ui/button';
import { formatTokenCount } from '@/renderer/lib/format';
import { PHASE_LABEL, actionLabel } from '../../../model/describe.js';
import type { ActionNode, CycleNode, ReasonNode, TreeEntry } from '../../../model/types.js';
import { ActionRow } from './ActionRow.js';
import { EntryRow } from './EntryRow.js';
import { TREE_CHILDREN, entryNodeId, phaseNodeId } from './ids.js';
import { useTreeExpansion } from './expansion.js';

const COLLAPSE_LINES = 12;

const ACTION_KIND_LABEL: Record<ActionNode['kind'], string> = {
  read: '读取',
  dispatch: '派发',
  write: '写入',
};

/** Rough token estimate for the thinking box label. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

function prepareSummary(entries: TreeEntry[]): string {
  if (entries.length === 0) return '未加载新资料';
  const calls = entries.filter((entry) => entry.kind === 'call');
  const counts: string[] = [];
  const memory = entries.filter((entry) => entry.kind === 'memory').length;
  const doc = entries.filter((entry) => entry.kind === 'doc').length;
  const file = entries.filter((entry) => entry.kind === 'file').length;
  const error = entries.filter((entry) => entry.kind === 'error').length;
  if (memory > 0) counts.push(`${memory} 条记忆`);
  if (doc > 0) counts.push(`${doc} 份文档`);
  if (file > 0) counts.push(`${file} 个文件`);
  if (error > 0) counts.push(`${error} 个错误`);
  const prefix = calls.map((call) => call.label).join(' · ');
  const parts = [prefix, counts.join(' · ')].filter((part) => part !== '');
  return parts.length > 0 ? parts.join(' · ') : '已更新上下文';
}

function reasonSummary(reason: ReasonNode | undefined): string {
  if (!reason) return '无推理内容';
  const tokens: string[] = [];
  if (reason.inputTokens !== undefined) tokens.push(`${formatTokenCount(reason.inputTokens)} 输入`);
  if (reason.outputTokens !== undefined) tokens.push(`${formatTokenCount(reason.outputTokens)} 输出`);
  return [reason.model, tokens.join(' · ')].filter((part) => part !== '').join(' · ');
}

function actSummary(actions: ActionNode[]): string {
  if (actions.length === 0) return '无动作';
  const parts = [`${actions.length} 个动作`];
  const done = actions.filter((action) => action.status === 'done').length;
  const running = actions.filter((action) => action.status === 'running').length;
  const failed = actions.filter((action) => action.status === 'failed').length;
  const timeout = actions.filter((action) => action.status === 'timeout').length;
  const cancelled = actions.filter((action) => action.status === 'cancelled').length;
  if (done > 0) parts.push(`${done} 完成`);
  if (running > 0) parts.push(`${running} 运行中`);
  if (failed > 0) parts.push(`${failed} 失败`);
  if (timeout > 0) parts.push(`${timeout} 超时`);
  if (cancelled > 0) parts.push(`${cancelled} 取消`);
  return parts.join(' · ');
}

function PhaseRow({ id, label, summary, children }: { id: string; label: string; summary: string; children: ReactNode }) {
  const { isOpen, toggle } = useTreeExpansion();
  const open = isOpen(id);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => toggle(id)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors hover:bg-muted/60"
      >
        {open
          ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="shrink-0 font-medium">{label}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summary}</span>
      </button>
      {open && <div className={TREE_CHILDREN}>{children}</div>}
    </div>
  );
}

function PreparePhase({ turn, cycle }: { turn: number; cycle: CycleNode }) {
  if (cycle.prepare.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">未加载新资料</p>;
  }
  return (
    <div className="flex flex-col">
      {cycle.prepare.map((entry, index) => (
        <EntryRow key={`${entry.at}-${index}`} entry={entry} nodeId={entryNodeId(turn, cycle.cycle, 'prepare', index)} />
      ))}
    </div>
  );
}

function ReasonText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const body = <Markdown>{text}</Markdown>;
  if (text.split('\n').length <= COLLAPSE_LINES) return body;
  return (
    <div className="flex flex-col">
      <div className={open ? undefined : 'max-h-64 overflow-hidden scroll-fade-b'}>{body}</div>
      <Button variant="ghost" size="sm" className="self-start" onClick={() => setOpen((value) => !value)}>
        {open ? '收起' : '展开全文'}
      </Button>
    </div>
  );
}

function ReasonActionRow({ turn, cycle, action }: { turn: number; cycle: number; action: ActionNode }) {
  const { jumpToAction } = useTreeExpansion();
  return (
    <button
      type="button"
      onClick={() => jumpToAction(turn, cycle, action.id)}
      className="flex w-full items-center gap-2 rounded-lg py-1 text-left text-sm transition-colors hover:bg-muted/60"
    >
      <span className="shrink-0 text-xs text-muted-foreground">{ACTION_KIND_LABEL[action.kind]}</span>
      <span className="min-w-0 flex-1 truncate">{actionLabel(action)}</span>
      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

function ReasonPhase({ turn, cycle }: { turn: number; cycle: CycleNode }) {
  const reason = cycle.reason;
  if (!reason && cycle.actions.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">无推理内容</p>;
  }
  return (
    <div className="flex flex-col gap-1 px-2 py-1">
      {reason?.thinking !== undefined && reason.thinking !== '' && (
        <Reasoning streaming={false} defaultOpen={false} title={`思考过程 · ${formatTokenCount(estimateTokens(reason.thinking))} token`}>
          {reason.thinking}
        </Reasoning>
      )}
      {reason?.text !== undefined && reason.text !== '' && <ReasonText text={reason.text} />}
      {cycle.actions.map((action) => (
        <ReasonActionRow key={action.id} turn={turn} cycle={cycle.cycle} action={action} />
      ))}
    </div>
  );
}

function ActPhase({ cycle }: { cycle: CycleNode }) {
  if (cycle.actions.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">没有行动</p>;
  }
  return (
    <div className="flex flex-col">
      {cycle.actions.map((action) => <ActionRow key={action.id} action={action} />)}
    </div>
  );
}

export interface PhaseRowsProps {
  turn: number;
  cycle: CycleNode;
}

/** The 准备 / 推理 / 行动 rows of one reasoning cycle. */
export function PhaseRows({ turn, cycle }: PhaseRowsProps) {
  return (
    <div className="flex flex-col">
      <PhaseRow id={phaseNodeId(turn, cycle.cycle, 'prepare')} label={PHASE_LABEL.preparing} summary={prepareSummary(cycle.prepare)}>
        <PreparePhase turn={turn} cycle={cycle} />
      </PhaseRow>
      <PhaseRow id={phaseNodeId(turn, cycle.cycle, 'reason')} label={PHASE_LABEL.reasoning} summary={reasonSummary(cycle.reason)}>
        <ReasonPhase turn={turn} cycle={cycle} />
      </PhaseRow>
      <PhaseRow id={phaseNodeId(turn, cycle.cycle, 'act')} label={PHASE_LABEL.acting} summary={actSummary(cycle.actions)}>
        <ActPhase cycle={cycle} />
      </PhaseRow>
      {cycle.errors.map((error, index) => (
        <p key={index} className="px-2 py-1 text-xs text-warning">{error}</p>
      ))}
    </div>
  );
}
