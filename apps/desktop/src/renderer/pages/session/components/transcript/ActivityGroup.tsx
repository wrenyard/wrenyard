/**
 * One collapsed stretch of agent work: a muted header line over the bordered
 * list of its step rows. The header's icon is the step kind when the group
 * holds one step and a list when it holds several. While a step runs, the
 * header names it with an animated ellipsis; once settled it summarises the
 * steps by kind, with a warning when some failed. A new group rises in.
 */
import { useState, type ComponentType } from 'react';
import {
  BookOpen,
  Brain,
  CalendarClock,
  ChevronRight,
  FileText,
  FolderGit2,
  GitBranch,
  History,
  List,
  ListTodo,
  Search,
  Send,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { cn } from 'cn';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/renderer/components/ui/collapsible';
import { ACTION_KIND_LABEL, CALL_ROLE_LABEL, materialTitle, stepName } from '../../model/describe.js';
import type { ActionModel, CallModel, ContextItem } from '../../model/types.js';
import { Ellipsis } from '../live-indicators.js';
import { MorphText } from '../morph-text.js';
import { ActionRow } from './ActionCard.js';
import { ActivityRow } from './ActivityRow.js';
import { AuxiliaryCallRow, ReasoningRow } from './CallRow.js';
import { ContextItemBody } from './ToolCard.js';

/** Re-exported from the model layer: the step union this group renders. */
export type { ActivityItem } from '../../model/types.js';
import type { ActivityItem } from '../../model/types.js';

/** Stable key of one item within its group. */
export function groupId(item: ActivityItem): string {
  switch (item.kind) {
    case 'reason':
    case 'call': return item.call.id;
    case 'action': return item.action.id;
    case 'context': return item.item.key;
  }
}

type Icon = ComponentType<{ className?: string }>;

const ACTION_ICON: Record<ActionModel['kind'], Icon> = {
  search: Search,
  dispatch: Send,
  document: FileText,
  todo: ListTodo,
  vcs: GitBranch,
  project: FolderGit2,
  schedule: CalendarClock,
  'parse-failed': Wrench,
};

const CALL_ICON: Partial<Record<CallModel['role'], Icon>> = {
  'memory-search': History,
  search: Search,
  document: FileText,
  todo: ListTodo,
  vcs: GitBranch,
  project: FolderGit2,
  schedule: CalendarClock,
};

/** The icon of one step. */
function itemIcon(item: ActivityItem): Icon {
  switch (item.kind) {
    case 'reason': return Brain;
    case 'call': return CALL_ICON[item.call.role] ?? Wrench;
    case 'action': return ACTION_ICON[item.action.kind];
    case 'context': return BookOpen;
  }
}

/** One count phrase per step kind, in first-seen order: `派发 2 个任务，思考 3 次`. */
function summary(items: readonly ActivityItem[]): string {
  const counts = new Map<string, { count: number; phrase: (count: number) => string }>();
  const add = (key: string, phrase: (count: number) => string): void => {
    const entry = counts.get(key);
    if (entry === undefined) counts.set(key, { count: 1, phrase });
    else entry.count += 1;
  };
  for (const item of items) {
    switch (item.kind) {
      case 'reason': add('reason', (n) => `思考 ${n} 次`); break;
      case 'context': add('context', (n) => `加载 ${n} 份资料`); break;
      case 'call': {
        const label = CALL_ROLE_LABEL[item.call.role] ?? item.call.role;
        add(`call:${item.call.role}`, (n) => `${label} ${n} 次`);
        break;
      }
      case 'action': {
        const kind = item.action.kind;
        add(`action:${kind}`, kind === 'dispatch' ? (n) => `派发 ${n} 个任务` : (n) => `${ACTION_KIND_LABEL[kind]} ${n} 次`);
        break;
      }
    }
  }
  return [...counts.values()].map(({ count, phrase }) => phrase(count)).join('，');
}

/**
 * The label of the group's running tool step, without the trailing ellipsis.
 * Reasoning in progress is told by the turn's live line, never here.
 */
function runningLabel(items: readonly ActivityItem[]): string | undefined {
  for (const item of items) {
    if (item.kind === 'call' && item.call.status === 'running') return `正在${CALL_ROLE_LABEL[item.call.role] ?? item.call.role}`;
    if (item.kind === 'action' && item.action.status === 'running') {
      // A step still waiting for its generated name reads as running.
      return item.action.title === '' ? '运行中' : item.action.title;
    }
  }
  return undefined;
}

/** How many items of the group reached a failed state. */
function failedCount(items: readonly ActivityItem[]): number {
  let failed = 0;
  for (const item of items) {
    if (item.kind === 'reason' || item.kind === 'call') {
      if (item.call.status === 'failed') failed += 1;
    } else if (item.kind === 'action' && item.action.status === 'failed') {
      failed += 1;
    }
  }
  return failed;
}

/** One context item as a step row. */
function ContextItemRow({ item }: { item: ContextItem }) {
  return (
    <ActivityRow verb="资料" subject={materialTitle(item)}>
      <ContextItemBody item={item} />
    </ActivityRow>
  );
}

export interface ActivityGroupProps {
  /** The group's items in time order. */
  items: readonly ActivityItem[];
  /** The turn's context items, including action-scoped ones, for step naming. */
  contextItems?: readonly ContextItem[];
  /** Ledger session id, forwarded to attachment media. */
  sessionId?: string;
  /** Cancel one dispatched task run; rejects when the daemon refuses. */
  onCancelTask: (taskRunId: string) => Promise<void>;
}

/** One collapsed stretch of agent work. */
export function ActivityGroup({ items, contextItems, sessionId, onCancelTask }: ActivityGroupProps) {
  const [open, setOpen] = useState(false);
  const running = runningLabel(items);
  const failed = failedCount(items);
  const actionTitleById = new Map(items.flatMap((item) => {
    if (item.kind !== 'action' || item.action.title.trim() === '') return [];
    return [[item.action.id, item.action.title] as const];
  }));
  const naming = { contextItems, actionTitle: (id: string) => actionTitleById.get(id) };
  const nameOf = (item: ActivityItem): string => stepName(item, naming);
  // A reasoning step joins the summary once it settled.
  const settled = items.filter((item) => !(item.kind === 'reason' && item.call.status === 'running'));
  if (running === undefined && settled.length === 0) return null;
  const HeaderIcon = items.length === 1 ? itemIcon(items[0]!) : List;
  // A group holding one settled step names that step; a multi-step group keeps
  // its kind-count summary.
  const settledLabel = settled.length === 1 && items.length === 1
    ? nameOf(settled[0]!)
    : `${summary(settled)}${failed > 0 ? `（${failed} 项失败）` : ''}`;
  const runningStep = items.find((item) =>
    (item.kind === 'reason' || item.kind === 'call') && item.call.status === 'running'
    || item.kind === 'action' && item.action.status === 'running');
  const runningText = runningStep === undefined ? running : nameOf(runningStep);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="wy-rise-in">
      <CollapsibleTrigger
        render={(
          <button
            type="button"
            className="group/act inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          />
        )}
      >
        <HeaderIcon className="size-3.5 shrink-0" aria-hidden />
        {runningText !== undefined ? (
          <span className="inline-flex min-w-0 items-baseline">
            <MorphText className="shimmer truncate" text={runningText} />
            <Ellipsis />
          </span>
        ) : (
          <>
            <span className="truncate">{settledLabel}</span>
            {failed > 0 && <TriangleAlert className="size-3.5 shrink-0" aria-label="有失败的步骤" />}
          </>
        )}
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-150 data-[ending-style]:h-0 data-[ending-style]:opacity-0 data-[starting-style]:h-0 data-[starting-style]:opacity-0">
        <div className="mt-1.5 overflow-hidden rounded-xl border bg-card/40">
          <div className="divide-y divide-border/60">
            {items.map((item) => {
              switch (item.kind) {
                case 'reason':
                  return <ReasoningRow key={groupId(item)} call={item.call} reasoning={item.reasoning} name={nameOf(item)} />;
                case 'call':
                  return <AuxiliaryCallRow key={groupId(item)} call={item.call} name={nameOf(item)} />;
                case 'action':
                  return (
                    <ActionRow
                      key={groupId(item)}
                      action={item.action}
                      calls={item.calls}
                      contextItems={contextItems}
                      sessionId={sessionId}
                      onCancelTask={onCancelTask}
                    />
                  );
                case 'context':
                  return <ContextItemRow key={groupId(item)} item={item.item} />;
              }
            })}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
