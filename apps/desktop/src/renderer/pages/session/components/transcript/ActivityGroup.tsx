/**
 * One collapsed stretch of agent work: a muted summary line over the bordered
 * list of its step rows. The summary shows a live label while an item runs.
 */
import { useState } from 'react';
import { ChevronRight, ListChecks } from 'lucide-react';
import { cn } from 'cn';
import { Elapsed } from '@/renderer/components/elapsed';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/renderer/components/ui/collapsible';
import { CALL_ROLE_LABEL, materialTitle } from '../../model/describe.js';
import type { ActionModel, CallModel, ContextItem, ReasoningModel } from '../../model/types.js';
import { LiveGlyph } from '../live-glyph.js';
import { MorphText } from '../morph-text.js';
import { ActionRow } from './ActionCard.js';
import { ActivityRow } from './ActivityRow.js';
import { AuxiliaryCallRow, ReasoningRow } from './CallRow.js';
import { ContextItemBody } from './ToolCard.js';

export type ActivityItem =
  | { kind: 'reason'; call: CallModel; reasoning?: ReasoningModel }
  | { kind: 'call'; call: CallModel }
  | { kind: 'action'; action: ActionModel; calls: readonly CallModel[] }
  | { kind: 'context'; item: ContextItem };

/** Stable key of one item within its group. */
export function groupId(item: ActivityItem): string {
  switch (item.kind) {
    case 'reason':
    case 'call': return item.call.id;
    case 'action': return item.action.id;
    case 'context': return item.item.key;
  }
}

/** The muted one-line summary of a group's finished work. */
function summary(items: readonly ActivityItem[]): string | undefined {
  let reasoning = 0;
  let actions = 0;
  let calls = 0;
  let contexts = 0;
  for (const item of items) {
    switch (item.kind) {
      case 'reason': reasoning += 1; break;
      case 'action': actions += 1; break;
      case 'call': calls += 1; break;
      case 'context': contexts += 1; break;
    }
  }
  const parts: string[] = [];
  if (reasoning > 0) parts.push(`思考 ${reasoning} 次`);
  if (actions > 0) parts.push(`执行 ${actions} 个操作`);
  if (calls > 0) parts.push(`辅助调用 ${calls} 次`);
  if (contexts > 0) parts.push(`加载 ${contexts} 份资料`);
  return parts.length === 0 ? undefined : parts.join('，');
}

/** Thinking verbs of a reasoning step, picked by step index so they are stable. */
const THINKING_VERBS = ['思考中…', '斟酌中…', '推敲中…', '琢磨中…', '梳理中…'];

/** The group's running item and the label shown in its place. */
function liveItem(items: readonly ActivityItem[]): { label: string } | undefined {
  let reasoning = 0;
  for (const item of items) {
    if (item.kind === 'reason') {
      const step = item.call.cycle ?? reasoning;
      reasoning += 1;
      if (item.call.status !== 'running') continue;
      return { label: THINKING_VERBS[step % THINKING_VERBS.length] ?? THINKING_VERBS[0] };
    }
    if (item.kind === 'call') {
      if (item.call.status !== 'running') continue;
      return { label: `正在${CALL_ROLE_LABEL[item.call.role] ?? item.call.role}…` };
    }
    if (item.kind === 'action' && item.action.status === 'running') {
      return { label: `正在执行：${item.action.title}` };
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
  /** Ledger session id, forwarded to attachment media. */
  sessionId?: string;
  /** Cancel one dispatched task run; rejects when the daemon refuses. */
  onCancelTask: (taskRunId: string) => Promise<void>;
  /** This group is the turn's live line, so its header tells the current step. */
  live?: boolean;
  /** Status text shown on the live line while no item of the group runs. */
  fallbackLabel?: string;
  /** Start of the task run whose elapsed time the live line shows. */
  taskStartedAt?: string;
}

/** One collapsed stretch of agent work. */
export function ActivityGroup({
  items,
  sessionId,
  onCancelTask,
  live = false,
  fallbackLabel,
  taskStartedAt,
}: ActivityGroupProps) {
  const [open, setOpen] = useState(false);
  const summaryText = summary(items);
  const running = liveItem(items);
  const failed = failedCount(items);
  const runningLabel = running?.label ?? fallbackLabel ?? '';
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={(
          <button
            type="button"
            className="group/act inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-sm text-muted-foreground hover:text-foreground"
          />
        )}
      >
        {live ? (
          <>
            <LiveGlyph />
            <MorphText className="shimmer truncate" text={runningLabel} />
            {taskStartedAt !== undefined && <Elapsed start={taskStartedAt} className="tabular-nums" />}
          </>
        ) : (
          <>
            <ListChecks className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
            <span className="truncate">{summaryText}</span>
            {running !== undefined && <span className="truncate text-muted-foreground/70">{' · 1 项进行中'}</span>}
            {failed > 0 && <span className="shrink-0 text-destructive">{` · ${failed} 项失败`}</span>}
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
                  return (
                    <ReasoningRow
                      key={groupId(item)}
                      call={item.call}
                      reasoning={item.reasoning}
                    />
                  );
                case 'call':
                  return <AuxiliaryCallRow key={groupId(item)} call={item.call} />;
                case 'action':
                  return (
                    <ActionRow
                      key={groupId(item)}
                      action={item.action}
                      calls={item.calls}
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
