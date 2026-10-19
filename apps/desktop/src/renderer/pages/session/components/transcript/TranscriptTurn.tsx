/**
 * One turn of the session rendered as an agent transcript: the right-aligned
 * user bubble, replies as plain prose, each stretch of agent work folded into
 * one muted summary line, visible errors, the running line and a hover footer.
 */
import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { cn } from 'cn';
import { AppMarkdown } from '@/renderer/components/app-markdown';
import { Elapsed } from '@/renderer/components/elapsed';
import { StatusBadge } from '@/renderer/components/status-badge';
import { Spinner } from '@/renderer/components/ui/spinner';
import { formatTokenCount } from '@/renderer/lib/format';
import {
  DISPATCH_TERMINAL_LABEL,
  TASK_RUN_PHASE_LABEL,
  dispatchTerminal,
  noFinalReply,
  runningTaskAction,
  statusView,
  turnStatusText,
  waitingStatusText,
} from '../../model/describe.js';
import type { TurnWaitingState } from '../../model/describe.js';
import type { ActionModel, CallModel, ErrorItem, ReplyModel, TurnModel } from '../../model/types.js';
import { MediaAttachments, fromSessionFile } from '../MediaAttachments.js';
import { InterruptButton } from '../conversation/TurnActivity.js';
import { HoverTime } from '../conversation/HoverTime.js';
import { ActivityGroup, groupId, type ActivityItem } from './ActivityGroup.js';

export interface TranscriptTurnProps {
  /** The folded turn to render. */
  turn: TurnModel;
  /** Ledger session id, forwarded to attachment media. */
  sessionId?: string;
  /** Interrupt this running turn. */
  onInterrupt: (turn: number) => void;
  /** Cancel one dispatched task run; rejects when the daemon refuses. */
  onCancelTask: (taskRunId: string) => Promise<void>;
  /** Live recovery waiting state of this turn, when it has one. */
  waiting?: TurnWaitingState;
}

function parseStamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sumDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

/** Aggregate input/cached/output tokens across the turn's expensive and cheap calls. */
function tokenSummary(turn: TurnModel): string | undefined {
  const { expensive, cheap } = turn.stats;
  const input = sumDefined(expensive.input, cheap.input);
  const cached = expensive.cachedInput;
  const output = sumDefined(expensive.output, cheap.output);
  const parts: string[] = [];
  if (input !== undefined) parts.push(`输入 ${formatTokenCount(input)}`);
  if (cached !== undefined) parts.push(`缓存 ${formatTokenCount(cached)}`);
  if (output !== undefined) parts.push(`输出 ${formatTokenCount(output)}`);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** A call belongs to an action when its parent or id prefix names that action. */
function attachedToAction(call: CallModel, actions: readonly ActionModel[]): boolean {
  return actions.some((action) => call.parent === action.id || call.id.startsWith(`${action.id}.`));
}

/** Plain prose block for one committed reply; not a card. */
function ReplyBlock({ reply }: { reply: ReplyModel }) {
  return (
    <div className="group/reply relative">
      <AppMarkdown className="text-sm leading-relaxed">{reply.text}</AppMarkdown>
      <HoverTime
        value={reply.at}
        className="absolute -right-1 top-0 translate-x-full opacity-0 transition-opacity group-hover/reply:opacity-100"
      />
    </div>
  );
}

/** A cycle or turn level error line. */
function ErrorRow({ error }: { error: ErrorItem }) {
  return (
    <p className="flex items-center gap-1.5 px-1 text-sm text-destructive">
      <TriangleAlert className="size-3.5 shrink-0" />
      {error.message}
    </p>
  );
}

type TranscriptEntry =
  | { kind: 'activity'; item: ActivityItem }
  | { kind: 'reply'; reply: ReplyModel }
  | { kind: 'error'; error: ErrorItem };

/** Chronological entries of a turn: activity items, prose replies and errors. */
function transcriptEntries(turn: TurnModel): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const turnCalls = turn.calls.filter(
    (call) => (call.cycle === undefined || call.cycle === 0)
      && call.role !== 'reason'
      && !attachedToAction(call, turn.actions),
  );
  const firstCycleStart = turn.cycles[0]?.startedAt;
  const beforeFirstCycle = (call: CallModel): boolean => firstCycleStart === undefined
    || parseStamp(call.startedAt) < parseStamp(firstCycleStart);
  for (const call of turnCalls.filter(beforeFirstCycle)) {
    entries.push({ kind: 'activity', item: { kind: 'call', call } });
  }

  for (const cycle of turn.cycles) {
    for (const item of cycle.context.filter((context) => context.actionId === undefined)) {
      entries.push({ kind: 'activity', item: { kind: 'context', item } });
    }
    const inCycle: { at: string; item: ActivityItem }[] = [];
    const reasoning = turn.calls.find((call) => call.role === 'reason' && call.cycle === cycle.index);
    if (reasoning !== undefined) {
      inCycle.push({
        at: reasoning.startedAt,
        item: { kind: 'reason', call: reasoning, reasoning: cycle.reasoning },
      });
    }
    const standalone = turn.calls.filter(
      (call) => call.cycle === cycle.index && call.role !== 'reason' && !attachedToAction(call, turn.actions),
    );
    for (const call of standalone) {
      inCycle.push({ at: call.startedAt, item: { kind: 'call', call } });
    }
    const actions = cycle.actionIds
      .map((id) => turn.actions.find((action) => action.id === id))
      .filter((action): action is ActionModel => action !== undefined);
    for (const action of actions) {
      const calls = turn.calls.filter(
        (call) => call.parent === action.id || call.id.startsWith(`${action.id}.`),
      );
      inCycle.push({ at: action.startedAt, item: { kind: 'action', action, calls } });
    }
    inCycle.sort((a, b) => parseStamp(a.at) - parseStamp(b.at));
    for (const entry of inCycle) entries.push({ kind: 'activity', item: entry.item });
    for (const error of cycle.errors) entries.push({ kind: 'error', error });
    for (const reply of turn.replies.filter((reply) => reply.cycle === cycle.index)) {
      entries.push({ kind: 'reply', reply });
    }
  }

  for (const call of turnCalls.filter((call) => !beforeFirstCycle(call))) {
    entries.push({ kind: 'activity', item: { kind: 'call', call } });
  }
  const cycleIndices = new Set(turn.cycles.map((cycle) => cycle.index));
  for (const reply of turn.replies.filter((reply) => reply.cycle === undefined || !cycleIndices.has(reply.cycle))) {
    entries.push({ kind: 'reply', reply });
  }
  for (const error of turn.errors.filter((error) => error.cycle === undefined)) {
    entries.push({ kind: 'error', error });
  }
  return entries;
}

/** One turn as a chronological transcript. */
export function TranscriptTurn({ turn, sessionId, onInterrupt, onCancelTask, waiting }: TranscriptTurnProps) {
  const attachments = (turn.user.attachments ?? []).map(fromSessionFile);
  const tokens = tokenSummary(turn);
  const fallback = noFinalReply(turn);
  // The implementation phase is timed from the task run it opened, separate
  // from the compile call's own duration; it is never shown as compiling.
  const taskRun = runningTaskAction(turn);
  // Terminal states are told apart only for a turn that dispatched: a compile
  // that never opened a task run reads as 编译失败, not as a running task.
  const terminal = turn.actions.some((action) => action.kind === 'dispatch') ? dispatchTerminal(turn) : undefined;

  // A maximal run of consecutive activity items becomes one summary group.
  const body: ReactNode[] = [];
  let run: ActivityItem[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    body.push(
      <ActivityGroup key={groupId(run[0]!)} items={run} sessionId={sessionId} onCancelTask={onCancelTask} />,
    );
    run = [];
  };
  for (const entry of transcriptEntries(turn)) {
    if (entry.kind === 'activity') {
      run.push(entry.item);
      continue;
    }
    flush();
    if (entry.kind === 'reply') {
      body.push(<ReplyBlock key={`${entry.reply.at}:${entry.reply.cycle ?? 0}`} reply={entry.reply} />);
    } else {
      body.push(<ErrorRow key={`${entry.error.at}:${entry.error.stage}`} error={entry.error} />);
    }
  }
  flush();

  return (
    <div className="group/turn flex flex-col gap-3">
      <div className="group/user flex justify-end">
        <HoverTime
          value={turn.user.at}
          className="mr-2 self-center text-[11px] opacity-0 group-hover/user:opacity-100"
        />
        <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-sm whitespace-pre-wrap break-words">
          {turn.user.text}
          {attachments.length > 0 && (
            <MediaAttachments items={attachments} sessionId={sessionId} className="mt-2" />
          )}
        </div>
      </div>

      {body}

      {turn.status === 'running' ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-3.5" />
          <span className={waiting === undefined ? 'shimmer' : undefined}>
            {waiting !== undefined
              ? waitingStatusText(waiting)
              : taskRun === undefined ? turnStatusText(turn) : `${TASK_RUN_PHASE_LABEL}…`}
          </span>
          {taskRun !== undefined && <Elapsed start={taskRun.startedAt} className="tabular-nums" />}
          <InterruptButton className="ml-auto" turn={turn} onInterrupt={onInterrupt} />
        </div>
      ) : turn.final === undefined ? (
        <p className={cn('px-1 text-sm', fallback.variant === 'destructive' ? 'text-destructive' : 'text-muted-foreground')}>
          {fallback.text}
        </p>
      ) : null}

      <div
        className={cn(
          'flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground tabular-nums transition-opacity',
          !(turn.status === 'failed' || turn.status === 'interrupted') && 'opacity-0 group-hover/turn:opacity-100',
        )}
      >
        {(turn.status === 'failed' || turn.status === 'interrupted') && (
          <StatusBadge tone={statusView(turn.status).tone} label={statusView(turn.status).label} />
        )}
        <span className="font-mono">{turn.model.provider}/{turn.model.model}</span>
        {turn.model.reasoningEffort !== undefined && <span>{turn.model.reasoningEffort}</span>}
        <Elapsed start={turn.startedAt} end={turn.endedAt} />
        {tokens !== undefined && <span>{tokens}</span>}
        {terminal !== undefined && <span>{DISPATCH_TERMINAL_LABEL[terminal]}</span>}
      </div>
    </div>
  );
}
