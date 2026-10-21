/**
 * One turn of the session rendered as an agent transcript, composed of the
 * right-aligned user-message component and the body component: replies as
 * plain prose, each stretch of agent work folded into one muted summary line,
 * visible errors, the running line and a per-message hover footer.
 */
import type { ReactNode } from 'react';
import { Activity, TriangleAlert } from 'lucide-react';
import { cn } from 'cn';
import { AppMarkdown } from '@/renderer/components/app-markdown';
import { MessageFooter } from '@/renderer/components/chat/MessageFooter';
import { Elapsed } from '@/renderer/components/elapsed';
import { openActivityPanel } from '@/renderer/lib/activity-panel';
import { formatTokenCount } from '@/renderer/lib/format';
import {
  DISPATCH_TERMINAL_LABEL,
  dispatchTerminal,
  runningStepName,
  thinkingVerb,
  turnTokenTotal,
  userSpeakerLabel,
  waitingStatusText,
} from '../../model/describe.js';
import type { TurnWaitingState } from '../../model/describe.js';
import type { ActionModel, ContextItem, ErrorItem, ModelEntry, ReplyModel, TurnModel } from '../../model/types.js';
import { MediaAttachments, fromSessionFile } from '../MediaAttachments.js';
import { splitReplyQuote } from '../conversation/UserMessage.js';
import { Ellipsis, WorkingDots } from '../live-indicators.js';
import { MorphText } from '../morph-text.js';
import { ActivityGroup, groupId, type GroupActivityItem } from './ActivityGroup.js';
import { transcriptEntries, type TranscriptEntry } from './transcript-timeline.js';

export interface TranscriptTurnProps {
  /** The folded turn to render. */
  turn: TurnModel;
  /** Ledger session id, forwarded to attachment media. */
  sessionId?: string;
  /** Model catalog, used to show a reply's model display name. */
  models?: readonly ModelEntry[];
  /** Bot display names, keyed by immutable bot id. */
  botNames?: ReadonlyMap<string, string>;
  /** Cancel one dispatched task run; rejects when the daemon refuses. */
  onCancelTask: (taskRunId: string) => Promise<void>;
  /** Live recovery waiting state of this turn, when it has one. */
  waiting?: TurnWaitingState;
}

/** The public id of the turn's reasoning model: the configured model, else the latest finished reason call's serving model. */
function reasoningModelId(turn: TurnModel): string | undefined {
  const { provider, model } = turn.model;
  if (provider !== '') return `${provider}/${model}`;
  if (model !== '') return model;
  const serving = turn.calls
    .filter((call) => call.role === 'reason' && call.endedAt !== undefined && call.model !== '')
    .at(-1);
  return serving?.model;
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
  showFooter,
  children,
}: {
  reply: ReplyModel;
  at?: string;
  model?: string;
  /** Only the turn's final reply shows the time/copy/model footer. */
  showFooter?: boolean;
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
      {showFooter === true && (
        <MessageFooter align="left" at={at} text={reply.text} model={model}>
          {children}
        </MessageFooter>
      )}
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
  | { kind: 'group'; items: GroupActivityItem[] }
  | { kind: 'reply'; reply: ReplyModel }
  | { kind: 'error'; error: ErrorItem };


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
      <Activity className="size-3.5" aria-hidden />
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

/** The right-aligned user message that opens a transcript turn. */
export function TranscriptUserMessage({ turn, sessionId, botNames }: { turn: TurnModel; sessionId?: string; botNames?: ReadonlyMap<string, string> }) {
  const attachments = (turn.user.attachments ?? []).map(fromSessionFile);
  const { body: userBody } = splitReplyQuote(turn.user.text);
  return (
    <div className="group/msg flex flex-col items-end gap-1.5">
      <span className="self-end px-1 text-xs text-muted-foreground">{userSpeakerLabel(turn.user.sender, botNames)}</span>
      <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-sm whitespace-pre-wrap break-words">
        {turn.user.text}
        {attachments.length > 0 && (
          <MediaAttachments items={attachments} sessionId={sessionId} className="mt-2" />
        )}
      </div>
      <MessageFooter align="right" at={turn.user.at} text={userBody} />
    </div>
  );
}

export interface TranscriptBodyProps extends TranscriptTurnProps {
  /** Chronological entries the body is built from. */
  entries: readonly TranscriptEntry[];
  /** Whether the running line is shown under the body. */
  live: boolean;
}

/** The body of a transcript turn: folded activity, replies, errors and the running line. */
export function TranscriptBody({ turn, sessionId, models, botNames, onCancelTask, waiting, entries, live }: TranscriptBodyProps) {
  // Terminal states are told apart only for a turn that dispatched: a compile
  // that never opened a task run reads as 编译失败, not as a running task.
  const terminal = turn.actions.some((action) => action.kind === 'dispatch') ? dispatchTerminal(turn) : undefined;

  // A maximal run of consecutive activity items becomes one summary group.
  const body: BodyBlock[] = [];
  let run: GroupActivityItem[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    body.push({ kind: 'group', items: run });
    run = [];
  };
  for (const entry of entries) {
    if (entry.kind === 'activity') {
      run.push(entry.item);
      continue;
    }
    flush();
    if (entry.kind === 'reply') body.push({ kind: 'reply', reply: entry.reply });
    else body.push({ kind: 'error', error: entry.error });
  }
  flush();

  // Every context item of the turn, including ones scoped to a span (memory
  // recalls fold onto action.outputs while unscoped ones stay on the cycle);
  // step naming looks memory-search hits up by their actionId.
  const contextItems: ContextItem[] = [
    ...turn.cycles.flatMap((cycle) => cycle.context),
    ...turn.actions.flatMap((action) => action.outputs),
  ];

  return (
    <>
      {body.map((block) => {
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
          // The turn's terminal state belongs to its last reply, and stays
          // visible even while the footer fades.
          const tail = block.reply === turn.replies.at(-1) && turn.status !== 'running';
          return (
            <ReplyBlock
              key={`${block.reply.at}:${block.reply.cycle ?? 0}`}
              reply={block.reply}
              at={block.reply.at || turn.endedAt}
              model={modelDisplayName(reasoningModelId(turn), models)}
              showFooter={tail}
            >
              {tail && terminal !== undefined && (
                <span className={terminal === 'not-started' ? 'text-muted-foreground' : 'text-destructive'}>
                  {DISPATCH_TERMINAL_LABEL[terminal]}
                </span>
              )}
            </ReplyBlock>
          );
        }
        return <ErrorRow key={`${block.error.at}:${block.error.stage}`} error={block.error} />;
      })}

      {live && <LiveLine turn={turn} sessionId={sessionId} waiting={waiting} />}
    </>
  );
}

/** One turn as a chronological transcript. */
export function TranscriptTurn({ turn, sessionId, models, botNames, onCancelTask, waiting }: TranscriptTurnProps) {
  return (
    <div className="relative flex flex-col gap-3" data-lightbox-root>
      <TranscriptUserMessage turn={turn} sessionId={sessionId} botNames={botNames} />
      <TranscriptBody
        turn={turn}
        sessionId={sessionId}
        models={models}
        botNames={botNames}
        onCancelTask={onCancelTask}
        waiting={waiting}
        entries={transcriptEntries(turn)}
        live={turn.status === 'running'}
      />
    </div>
  );
}
