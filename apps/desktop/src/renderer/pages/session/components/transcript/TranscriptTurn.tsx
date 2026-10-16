/**
 * One turn of the session rendered as an inline transcript: the user block, a
 * quiet metadata row, the turn's steps with their reasoning, actions and
 * auxiliary calls, and the resulting replies. Everything is collapsed by
 * default except work that is still running.
 */
import type { ReactNode } from 'react';
import { FileText, TriangleAlert } from 'lucide-react';
import { cn } from 'cn';
import { AppMarkdown } from '@/renderer/components/app-markdown';
import { Elapsed } from '@/renderer/components/elapsed';
import { StatusBadge } from '@/renderer/components/status-badge';
import { Timestamp } from '@/renderer/components/timestamp';
import { Spinner } from '@/renderer/components/ui/spinner';
import { formatTokenCount } from '@/renderer/lib/format';
import {
  DISPATCH_TERMINAL_LABEL,
  TASK_RUN_PHASE_LABEL,
  cycleLabel,
  dispatchTerminal,
  noFinalReply,
  runningTaskAction,
  statusView,
  turnStatusText,
} from '../../model/describe.js';
import type { ActionModel, CallModel, CycleModel, ErrorItem, ReplyModel, TurnModel } from '../../model/types.js';
import { MediaAttachments, fromSessionFile } from '../MediaAttachments.js';
import { InterruptButton } from '../conversation/TurnActivity.js';
import { ActionCard } from './ActionCard.js';
import { CallRow, ReasoningCard } from './CallRow.js';
import { ContextItems, ToolCard } from './ToolCard.js';

export interface TranscriptTurnProps {
  /** The folded turn to render. */
  turn: TurnModel;
  /** Ledger session id, forwarded to attachment media. */
  sessionId?: string;
  /** Interrupt this running turn. */
  onInterrupt: (turn: number) => void;
  /** Cancel one dispatched task run; rejects when the daemon refuses. */
  onCancelTask: (taskRunId: string) => Promise<void>;
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

/** Plain labeled Markdown block for one committed reply; not a card. */
function ReplyBlock({ reply }: { reply: ReplyModel }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs text-muted-foreground">
        助手 · <Timestamp value={reply.at} precision="second" />
      </div>
      <AppMarkdown className="text-sm">{reply.text}</AppMarkdown>
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

interface CycleBlockProps {
  turn: TurnModel;
  cycle: CycleModel;
  /** Zero-based position, used to mark the running last cycle on the rail. */
  position: number;
  sessionId?: string;
  onCancelTask: (taskRunId: string) => Promise<void>;
}

/** One reasoning cycle on the step rail. */
function CycleBlock({ turn, cycle, position, sessionId, onCancelTask }: CycleBlockProps) {
  const runningCycle = turn.status === 'running' && position === turn.cycles.length - 1;
  const contextItems = cycle.context.filter((item) => item.actionId === undefined);
  const reasoning = turn.calls.find((call) => call.role === 'reason' && call.cycle === cycle.index);
  const actions = cycle.actionIds
    .map((id) => turn.actions.find((action) => action.id === id))
    .filter((action): action is ActionModel => action !== undefined);
  const standaloneCalls = turn.calls.filter(
    (call) => call.cycle === cycle.index && call.role !== 'reason' && !attachedToAction(call, turn.actions),
  );
  const entries: { at: string; node: ReactNode }[] = [];
  if (reasoning !== undefined) {
    entries.push({ at: reasoning.startedAt, node: <ReasoningCard key={reasoning.id} call={reasoning} reasoning={cycle.reasoning} /> });
  }
  for (const call of standaloneCalls) entries.push({ at: call.startedAt, node: <CallRow key={call.id} call={call} /> });
  for (const action of actions) {
    const attached = turn.calls.filter(
      (call) => call.parent === action.id || call.id.startsWith(`${action.id}.`),
    );
    entries.push({
      at: action.startedAt,
      node: (
        <ActionCard
          key={action.id}
          action={action}
          calls={attached}
          sessionId={sessionId}
          onCancelTask={onCancelTask}
        />
      ),
    });
  }
  entries.sort((a, b) => parseStamp(a.at) - parseStamp(b.at));
  const replies = turn.replies.filter((reply) => reply.cycle === cycle.index);
  return (
    <li className="relative flex flex-col gap-1.5">
      <span
        className={cn(
          'absolute top-1.5 -left-[21px] size-2 rounded-full',
          runningCycle ? 'bg-primary motion-pulse-slow' : 'bg-border',
        )}
      />
      <div className="text-xs font-medium text-muted-foreground">
        {cycleLabel(cycle.index)} · <Elapsed start={cycle.startedAt} end={cycle.endedAt} />
      </div>
      {contextItems.length > 0 && (
        <ToolCard icon={<FileText />} label={`加载了 ${contextItems.length} 份资料`} defaultOpen={false}>
          <ContextItems items={contextItems} />
        </ToolCard>
      )}
      {entries.map((entry) => entry.node)}
      {cycle.errors.map((error) => <ErrorRow key={`${error.at}:${error.stage}`} error={error} />)}
      {replies.map((reply) => <ReplyBlock key={`${reply.at}:${reply.cycle ?? 0}`} reply={reply} />)}
    </li>
  );
}

/** One turn as an inline, chronological transcript. */
export function TranscriptTurn({ turn, sessionId, onInterrupt, onCancelTask }: TranscriptTurnProps) {
  const attachments = (turn.user.attachments ?? []).map(fromSessionFile);
  // Turn-level auxiliary calls carry no cycle (or cycle 0) and are not run by
  // an action; the fold leaves them on the turn.
  const turnCalls = turn.calls.filter(
    (call) => (call.cycle === undefined || call.cycle === 0)
      && call.role !== 'reason'
      && !attachedToAction(call, turn.actions),
  );
  const firstCycleStart = turn.cycles[0]?.startedAt;
  const beforeFirstCycle = (call: CallModel): boolean => firstCycleStart === undefined
    || parseStamp(call.startedAt) < parseStamp(firstCycleStart);
  const leadingCalls = turnCalls.filter(beforeFirstCycle);
  const trailingCalls = turnCalls.filter((call) => !beforeFirstCycle(call));
  const cycleIndices = new Set(turn.cycles.map((cycle) => cycle.index));
  const looseReplies = turn.replies.filter((reply) => reply.cycle === undefined || !cycleIndices.has(reply.cycle));
  const looseErrors = turn.errors.filter((error) => error.cycle === undefined);
  const tokens = tokenSummary(turn);
  const fallback = noFinalReply(turn);
  // The implementation phase is timed from the task run it opened, separate
  // from the compile call's own duration; it is never shown as compiling.
  const taskRun = runningTaskAction(turn);
  // Terminal states are told apart only for a turn that dispatched: a compile
  // that never opened a task run reads as 编译失败, not as a running task.
  const terminal = turn.actions.some((action) => action.kind === 'dispatch') ? dispatchTerminal(turn) : undefined;
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl bg-muted/60 px-4 py-3">
        <div className="text-xs text-muted-foreground">
          你 · <Timestamp value={turn.user.at} precision="second" />
        </div>
        <div className="mt-1 whitespace-pre-wrap text-sm">{turn.user.text}</div>
        {attachments.length > 0 && (
          <MediaAttachments items={attachments} sessionId={sessionId} className="mt-2" />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">轮次 {turn.id}</span>
        <span className="font-mono">{turn.model.provider}/{turn.model.model}</span>
        {turn.model.reasoningEffort !== undefined && <span>{turn.model.reasoningEffort}</span>}
        {turn.status === 'running' ? (
          <span className="inline-flex items-center gap-1">
            <Spinner className="size-3" />运行中
          </span>
        ) : (
          <StatusBadge tone={statusView(turn.status).tone} label={statusView(turn.status).label} />
        )}
        {terminal !== undefined && <span>{DISPATCH_TERMINAL_LABEL[terminal]}</span>}
        <Elapsed start={turn.startedAt} end={turn.endedAt} />
        {tokens !== undefined && <span>{tokens}</span>}
        <InterruptButton className="ml-auto" turn={turn} onInterrupt={onInterrupt} />
      </div>

      {leadingCalls.map((call) => <CallRow key={call.id} call={call} />)}

      {turn.cycles.length > 0 && (
        <ol className="ml-1.5 flex flex-col gap-4 border-l border-border/70 pl-4">
          {turn.cycles.map((cycle, position) => (
            <CycleBlock
              key={cycle.index}
              turn={turn}
              cycle={cycle}
              position={position}
              sessionId={sessionId}
              onCancelTask={onCancelTask}
            />
          ))}
        </ol>
      )}

      {trailingCalls.map((call) => <CallRow key={call.id} call={call} />)}
      {looseReplies.map((reply) => <ReplyBlock key={`${reply.at}:${reply.cycle ?? 0}`} reply={reply} />)}
      {looseErrors.map((error) => <ErrorRow key={`${error.at}:${error.stage}`} error={error} />)}

      {turn.status === 'running' ? (
        <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
          <Spinner className="size-3.5" />
          <span className="shimmer">{taskRun === undefined ? turnStatusText(turn) : `${TASK_RUN_PHASE_LABEL}…`}</span>
          {taskRun !== undefined && <Elapsed start={taskRun.startedAt} className="tabular-nums" />}
        </div>
      ) : turn.final === undefined ? (
        <p className={cn('px-1 text-sm', fallback.variant === 'destructive' ? 'text-destructive' : 'text-muted-foreground')}>
          {fallback.text}
        </p>
      ) : null}
    </div>
  );
}
