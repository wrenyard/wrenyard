/**
 * One turn of the session rendered as an agent transcript: the right-aligned
 * user bubble, replies as plain prose, each stretch of agent work folded into
 * one muted summary line, visible errors, the running line and a per-message
 * hover footer.
 */
import type { ReactNode } from 'react';
import { ListTodo, TriangleAlert } from 'lucide-react';
import { cn } from 'cn';
import { AppMarkdown } from '@/renderer/components/app-markdown';
import { MessageFooter } from '@/renderer/components/chat/MessageFooter';
import { Elapsed } from '@/renderer/components/elapsed';
import { openActivityPanel } from '@/renderer/lib/activity-panel';
import {
  DISPATCH_TERMINAL_LABEL,
  HIDDEN_CALL_ROLES,
  dispatchTerminal,
  runningStepName,
  thinkingVerb,
  turnTokenTotal,
  waitingStatusText,
} from '../../model/describe.js';
import type { TurnWaitingState } from '../../model/describe.js';
import type { ActionModel, CallModel, ContextItem, ErrorItem, ModelEntry, ReplyModel, TurnModel } from '../../model/types.js';
import { MediaAttachments, fromSessionFile } from '../MediaAttachments.js';
import { splitReplyQuote } from '../conversation/UserMessage.js';
import { Ellipsis, WorkingDots } from '../live-indicators.js';
import { MorphText } from '../morph-text.js';
import { ActivityGroup, groupId, type ActivityItem } from './ActivityGroup.js';

export interface TranscriptTurnProps {
  /** The folded turn to render. */
  turn: TurnModel;
  /** Ledger session id, forwarded to attachment media. */
  sessionId?: string;
  /** Model catalog, used to show a reply's model display name. */
  models?: readonly ModelEntry[];
  /** Cancel one dispatched task run; rejects when the daemon refuses. */
  onCancelTask: (taskRunId: string) => Promise<void>;
  /** Live recovery waiting state of this turn, when it has one. */
  waiting?: TurnWaitingState;
}

function parseStamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A call belongs to an action when its parent or id prefix names that action. */
function attachedToAction(call: CallModel, actions: readonly ActionModel[]): boolean {
  return actions.some((action) => call.parent === action.id || call.id.startsWith(`${action.id}.`));
}

/** The public id of the call that produced a reply, else the turn's model. */
function replyModelId(reply: ReplyModel, turn: TurnModel): string | undefined {
  const producer = turn.calls
    .filter((call) => call.role === 'reply'
      && (reply.cycle === undefined || call.cycle === reply.cycle)
      && call.endedAt !== undefined
      && parseStamp(call.endedAt) <= parseStamp(reply.at))
    .at(-1);
  if (producer !== undefined && producer.model !== '') return producer.model;
  const { provider, model } = turn.model;
  if (provider === '') return model === '' ? undefined : model;
  return `${provider}/${model}`;
}

/** Catalog display name of a public model id, else its bare model id. */
function modelDisplayName(publicId: string | undefined, models: readonly ModelEntry[] | undefined): string | undefined {
  if (publicId === undefined) return undefined;
  const entry = models?.find((candidate) => candidate.publicId === publicId);
  if (entry !== undefined) return entry.displayName;
  const separator = publicId.indexOf('/');
  return separator === -1 ? publicId : publicId.slice(separator + 1);
}

/** Plain prose block for one committed reply; not a card. */
function ReplyBlock({
  reply,
  at,
  model,
  children,
}: {
  reply: ReplyModel;
  at?: string;
  model?: string;
  children?: ReactNode;
}) {
  return (
    <div className="group/msg relative flex flex-col gap-1.5">
      <AppMarkdown
        className={cn(
          'text-sm leading-relaxed',
          reply.tone === 'destructive' ? 'text-destructive' : reply.tone === 'muted' ? 'text-muted-foreground' : undefined,
        )}
      >
        {reply.text}
      </AppMarkdown>
      <MessageFooter align="left" at={at} text={reply.text} model={model}>
        {children}
      </MessageFooter>
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

/**
 * Muted chip `≣ N 个任务` at the right end of the live line or the last
 * turn's footer; opens the activity side panel scoped to this session's tasks.
 */
function RunningTasks({ tasks, sessionId }: { tasks: readonly ActionModel[]; sessionId?: string }) {
  if (tasks.length === 0) return null;
  return (
    <button
      type="button"
      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded text-muted-foreground hover:text-foreground"
      onClick={() => openActivityPanel(sessionId)}
    >
      <ListTodo className="size-3.5" aria-hidden />
      {tasks.length} 个任务
    </button>
  );
}

/**
 * The running turn's bottom line on one row: accent working dots, the step
 * being run (or the waiting or interrupting notice), its elapsed time and token
 * total, and the count of task runs still working.
 */
function LiveLine({ turn, sessionId, waiting }: { turn: TurnModel; sessionId?: string; waiting?: TurnWaitingState }) {
  const thinking = turn.calls.find((call) => call.role === 'reason' && call.status === 'running');
  const step = runningStepName(turn);
  const total = turnTokenTotal(turn);
  return (
    <div className="wy-rise-in flex items-center gap-2 text-sm text-muted-foreground">
      <WorkingDots />
      {waiting !== undefined ? (
        <MorphText className="min-w-0 truncate" text={waitingStatusText(waiting)} />
      ) : turn.interrupting ? (
        <span>正在中断<Ellipsis /></span>
      ) : step !== undefined ? (
        <MorphText className="shimmer min-w-0 truncate" text={step} />
      ) : null}
      <span className="shrink-0">
        <Elapsed start={turn.startedAt} className="tabular-nums" />
        {total !== undefined && ` · ${formatTokenCount(total)} tokens`}
      </span>
      {waiting === undefined && !turn.interrupting && step === undefined && thinking !== undefined && (
        <>
          <span>·</span>
          <span className="inline-flex items-baseline text-primary">
            <MorphText className="shimmer" text={thinkingVerb(thinking.cycle ?? turn.cycle)} />
            <Ellipsis />
          </span>
        </>
      )}
      <RunningTasks tasks={runningTasks(turn)} sessionId={sessionId} />
    </div>
  );
}

/** One turn as a chronological transcript. */
export function TranscriptTurn({ turn, sessionId, models, onCancelTask, waiting }: TranscriptTurnProps) {
  const attachments = (turn.user.attachments ?? []).map(fromSessionFile);
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

  let lastReplyIndex = -1;
  body.forEach((block, index) => {
    if (block.kind === 'reply') lastReplyIndex = index;
  });
  const { body: userBody } = splitReplyQuote(turn.user.text);

  // Every context item of the turn, including ones scoped to a span (memory
  // recalls fold onto action.outputs while unscoped ones stay on the cycle);
  // step naming looks memory-search hits up by their actionId.
  const contextItems: ContextItem[] = [
    ...turn.cycles.flatMap((cycle) => cycle.context),
    ...turn.actions.flatMap((action) => action.outputs),
  ];

  return (
    <div className="relative flex flex-col gap-3" data-lightbox-root>
      <div className="group/msg flex flex-col items-end gap-1.5">
        <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-sm whitespace-pre-wrap break-words">
          {turn.user.text}
          {attachments.length > 0 && (
            <MediaAttachments items={attachments} sessionId={sessionId} className="mt-2" />
          )}
        </div>
        <MessageFooter align="right" at={turn.user.at} text={userBody} />
      </div>

      {body.map((block, index) => {
        if (block.kind === 'group') {
          return (
            <ActivityGroup
              key={groupId(block.items[0]!)}
              items={block.items}
              contextItems={contextItems}
              sessionId={sessionId}
              onCancelTask={onCancelTask}
            />
          );
        }
        if (block.kind === 'reply') {
          // The turn's terminal state and still-running tasks belong to its
          // last reply, and stay visible even while the footer fades.
          const tail = index === lastReplyIndex;
          return (
            <ReplyBlock
              key={`${block.reply.at}:${block.reply.cycle ?? 0}`}
              reply={block.reply}
              at={block.reply.at || turn.endedAt}
              model={modelDisplayName(replyModelId(block.reply, turn), models)}
            >
              {tail && terminal !== undefined && <span>{DISPATCH_TERMINAL_LABEL[terminal]}</span>}
              {tail && <RunningTasks tasks={runningTasks(turn)} sessionId={sessionId} />}
            </ReplyBlock>
          );
        }
        return <ErrorRow key={`${block.error.at}:${block.error.stage}`} error={block.error} />;
      })}

      {turn.status === 'running' && <LiveLine turn={turn} sessionId={sessionId} waiting={waiting} />}
    </div>
  );
}
