/**
 * One turn of the session rendered as an agent transcript: the right-aligned
 * user bubble, replies as plain prose, each stretch of agent work folded into
 * one muted summary line, visible errors, the running line and a hover footer.
 */
import { ArrowDown, ArrowUp, DatabaseZap, TriangleAlert } from 'lucide-react';
import { cn } from 'cn';
import { AppMarkdown } from '@/renderer/components/app-markdown';
import { CopyButton } from '@/renderer/components/copy-button';
import { Elapsed } from '@/renderer/components/elapsed';
import { shell } from '@/renderer/lib/desktop';
import { formatTokenCount } from '@/renderer/lib/format';
import {
  DISPATCH_TERMINAL_LABEL,
  HIDDEN_CALL_ROLES,
  dispatchTerminal,
  thinkingVerb,
  waitingStatusText,
} from '../../model/describe.js';
import type { TurnWaitingState } from '../../model/describe.js';
import type { ActionModel, CallModel, ErrorItem, ReplyModel, TurnModel } from '../../model/types.js';
import { MediaAttachments, fromSessionFile } from '../MediaAttachments.js';
import { HoverTime } from '../conversation/HoverTime.js';
import { Ellipsis, WorkingDots } from '../live-indicators.js';
import { MorphText } from '../morph-text.js';
import { ActivityGroup, groupId, type ActivityItem } from './ActivityGroup.js';

export interface TranscriptTurnProps {
  /** The folded turn to render. */
  turn: TurnModel;
  /** Ledger session id, forwarded to attachment media. */
  sessionId?: string;
  /** The newest turn of the session: its footer stays visible once finished. */
  latest?: boolean;
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

/** Input, cached input and output tokens of the turn, each with its icon. */
function TokenFigures({ turn }: { turn: TurnModel }) {
  const { expensive, cheap } = turn.stats;
  const figures = [
    { key: 'input', icon: ArrowUp, label: '输入', value: sumDefined(expensive.input, cheap.input) },
    { key: 'cached', icon: DatabaseZap, label: '缓存', value: expensive.cachedInput },
    { key: 'output', icon: ArrowDown, label: '输出', value: sumDefined(expensive.output, cheap.output) },
  ];
  return figures.map(({ key, icon: Icon, label, value }) => value === undefined ? null : (
    <span key={key} className="inline-flex items-center gap-0.5" title={`${label} ${formatTokenCount(value)}`}>
      <Icon className="size-3" aria-label={label} />
      {formatTokenCount(value)}
    </span>
  ));
}

/** What the copy button copies: the turn's final reply, else its last reply. */
function copyableReply(turn: TurnModel): string | undefined {
  const reply = turn.replies.filter((item) => item.kind === 'final').at(-1) ?? turn.replies.at(-1);
  return reply === undefined || reply.text.trim() === '' ? undefined : reply.text;
}

/** A call belongs to an action when its parent or id prefix names that action. */
function attachedToAction(call: CallModel, actions: readonly ActionModel[]): boolean {
  return actions.some((action) => call.parent === action.id || call.id.startsWith(`${action.id}.`));
}

/** Plain prose block for one committed reply; not a card. */
function ReplyBlock({ reply }: { reply: ReplyModel }) {
  return (
    <div className="group/reply relative">
      <AppMarkdown
        className={cn(
          'text-sm leading-relaxed',
          reply.tone === 'destructive' ? 'text-destructive' : reply.tone === 'muted' ? 'text-muted-foreground' : undefined,
        )}
      >
        {reply.text}
      </AppMarkdown>
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

/** One body block: a folded activity group, a prose reply or an error line. */
type BodyBlock =
  | { kind: 'group'; items: ActivityItem[] }
  | { kind: 'reply'; reply: ReplyModel }
  | { kind: 'error'; error: ErrorItem };

type TranscriptEntry =
  | { kind: 'activity'; item: ActivityItem }
  | { kind: 'reply'; reply: ReplyModel }
  | { kind: 'error'; error: ErrorItem };

/** Chronological entries of a turn: activity items, prose replies and errors. */
function transcriptEntries(turn: TurnModel): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const visibleCalls = turn.calls.filter((call) => !HIDDEN_CALL_ROLES.has(call.role));
  const turnCalls = visibleCalls.filter(
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
    const reasoning = visibleCalls.find((call) => call.role === 'reason' && call.cycle === cycle.index);
    if (reasoning !== undefined) {
      inCycle.push({
        at: reasoning.startedAt,
        item: { kind: 'reason', call: reasoning, reasoning: cycle.reasoning },
      });
    }
    const standalone = visibleCalls.filter(
      (call) => call.cycle === cycle.index && call.role !== 'reason' && !attachedToAction(call, turn.actions),
    );
    for (const call of standalone) {
      inCycle.push({ at: call.startedAt, item: { kind: 'call', call } });
    }
    const actions = cycle.actionIds
      .map((id) => turn.actions.find((action) => action.id === id))
      .filter((action): action is ActionModel => action !== undefined);
    for (const action of actions) {
      const calls = visibleCalls.filter(
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

/** Dispatched task runs of the turn that are still running. */
function runningTasks(turn: TurnModel): ActionModel[] {
  return turn.actions.filter((action) => action.kind === 'dispatch' && action.status === 'running' && action.taskRunId !== undefined);
}

/** `· N 个任务运行中`; opens the first running task's transcript. */
function RunningTasks({ tasks }: { tasks: readonly ActionModel[] }) {
  if (tasks.length === 0) return null;
  const first = tasks[0]!;
  return (
    <>
      <span aria-hidden>·</span>
      <button
        type="button"
        className="rounded hover:text-foreground hover:underline"
        onClick={() => { if (first.taskRunId !== undefined) void shell.openTaskTranscript(first.taskRunId, first.title); }}
      >
        {tasks.length} 个任务运行中
      </button>
    </>
  );
}

/**
 * The running turn's bottom line: accent working dots, then the thinking verb
 * while the model reasons, or the turn's elapsed time while steps run, plus
 * the count of task runs still working.
 */
function LiveLine({ turn, waiting }: { turn: TurnModel; waiting?: TurnWaitingState }) {
  const thinking = turn.calls.find((call) => call.role === 'reason' && call.status === 'running');
  let label;
  if (waiting !== undefined) label = <MorphText className="truncate" text={waitingStatusText(waiting)} />;
  else if (turn.interrupting) label = <span>正在中断<Ellipsis /></span>;
  else if (thinking !== undefined) {
    label = (
      <span className="inline-flex items-baseline text-primary">
        <MorphText className="shimmer" text={thinkingVerb(thinking.cycle ?? turn.cycle)} />
        <Ellipsis />
      </span>
    );
  } else {
    label = <Elapsed start={turn.startedAt} className="tabular-nums" />;
  }
  return (
    <div className="wy-rise-in flex items-center gap-2 text-sm text-muted-foreground">
      <WorkingDots />
      {label}
      <RunningTasks tasks={runningTasks(turn)} />
    </div>
  );
}

/** One turn as a chronological transcript. */
export function TranscriptTurn({ turn, sessionId, latest = false, onCancelTask, waiting }: TranscriptTurnProps) {
  const attachments = (turn.user.attachments ?? []).map(fromSessionFile);
  const reply = copyableReply(turn);
  // Terminal states are told apart only for a turn that dispatched: a compile
  // that never opened a task run reads as 编译失败, not as a running task.
  const terminal = turn.actions.some((action) => action.kind === 'dispatch') ? dispatchTerminal(turn) : undefined;

  // A maximal run of consecutive activity items becomes one summary group.
  const body: BodyBlock[] = [];
  let run: ActivityItem[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    body.push({ kind: 'group', items: run });
    run = [];
  };
  for (const entry of transcriptEntries(turn)) {
    if (entry.kind === 'activity') {
      run.push(entry.item);
      continue;
    }
    flush();
    if (entry.kind === 'reply') body.push({ kind: 'reply', reply: entry.reply });
    else body.push({ kind: 'error', error: entry.error });
  }
  flush();

  // The footer describes a finished turn, so it is absent while the turn runs.
  // It stays in view on the newest turn and on failed or interrupted ones;
  // elsewhere it shows on hover without reserving height.
  const footerInFlow = latest || turn.status === 'failed' || turn.status === 'interrupted';

  return (
    <div className="group/turn relative flex flex-col gap-3" data-lightbox-root>
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

      {body.map((block) => {
        if (block.kind === 'group') {
          return (
            <ActivityGroup
              key={groupId(block.items[0]!)}
              items={block.items}
              sessionId={sessionId}
              onCancelTask={onCancelTask}
            />
          );
        }
        if (block.kind === 'reply') {
          return <ReplyBlock key={`${block.reply.at}:${block.reply.cycle ?? 0}`} reply={block.reply} />;
        }
        return <ErrorRow key={`${block.error.at}:${block.error.stage}`} error={block.error} />;
      })}

      {turn.status === 'running' && <LiveLine turn={turn} waiting={waiting} />}

      {turn.status !== 'running' && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground tabular-nums transition-opacity',
            // A hidden footer is taken out of the flow so it leaves no empty band
            // between this turn and the next one.
            footerInFlow
              ? undefined
              : 'pointer-events-none absolute inset-x-0 top-full opacity-0 group-hover/turn:pointer-events-auto group-hover/turn:opacity-100',
          )}
        >
          <span className="font-mono">{turn.model.provider}/{turn.model.model}</span>
          {turn.model.reasoningEffort !== undefined && <span>{turn.model.reasoningEffort}</span>}
          <Elapsed start={turn.startedAt} end={turn.endedAt} />
          <TokenFigures turn={turn} />
          {terminal !== undefined && <span>{DISPATCH_TERMINAL_LABEL[terminal]}</span>}
          <RunningTasks tasks={runningTasks(turn)} />
          {reply !== undefined && (
            <CopyButton text={reply} label="复制回复" size="icon-xs" className="-my-1 text-muted-foreground" />
          )}
        </div>
      )}
    </div>
  );
}
