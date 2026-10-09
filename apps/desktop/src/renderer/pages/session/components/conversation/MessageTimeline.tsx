import { memo } from 'react';
import { MessageScrollerItem } from '@/renderer/components/ui/message-scroller';
import { useNow } from '@/renderer/hooks/use-now';
import { shell } from '@/renderer/lib/desktop';
import { formatDivider } from '@/renderer/lib/format';
import { prefersReducedMotion } from '@/renderer/lib/motion';
import { DIVIDER_GAP_MS } from '../../model/dividers.js';
import type { ActionModel, DraftAttachment, ReplyModel, TurnModel } from '../../model/types.js';
import type { PendingTurn } from '../../state/session-reducer.js';
import { MediaAttachments, fromDraftAttachment, fromSessionFile } from '../MediaAttachments.js';
import { AssistantMessage } from './AssistantMessage.js';
import { TimeDivider } from './TimeDivider.js';
import { isWritingReply, TurnStatus } from './TurnStatus.js';
import { splitReplyQuote, UserMessage } from './UserMessage.js';

/** One independently positioned row of the conversation. */
export interface TimelineUserEntry {
  kind: 'user';
  id: string;
  at: string;
  turn: TurnModel;
}

export interface TimelinePendingEntry {
  kind: 'pending';
  id: string;
  at: string;
  pending: PendingTurn;
}

export interface TimelineReplyEntry {
  kind: 'reply';
  id: string;
  at: string;
  turn: TurnModel;
  reply: ReplyModel;
  reference?: MessageReference;
}

export interface TimelineFallbackEntry {
  kind: 'fallback';
  id: string;
  at: string;
  turn: TurnModel;
  reference?: MessageReference;
}

export interface TimelineArtifactEntry {
  kind: 'artifact';
  id: string;
  at: string;
  turn: TurnModel;
  action: ActionModel;
}

export type MessageTimelineEntry =
  | TimelineUserEntry
  | TimelinePendingEntry
  | TimelineReplyEntry
  | TimelineFallbackEntry
  | TimelineArtifactEntry;

interface MessageReference {
  messageId: string;
  author: string;
  text: string;
}

/** Single-line excerpt of a message used for quotes. */
function excerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function userText(turn: TurnModel): string {
  return splitReplyQuote(turn.user.text).body || (turn.user.attachments ?? []).map((file) => file.name).join('、') || '附件';
}

/** Quote the previous chat message of a turn only across intervening turns. */
function withReplyReferences(entries: MessageTimelineEntry[]): MessageTimelineEntry[] {
  const latest = new Map<number, { index: number; message: MessageReference }>();
  let previousTurn: number | undefined;
  let runStart = 0;
  return entries.map((entry, index) => {
    const turnId = entry.kind === 'pending' ? undefined : entry.turn.id;
    if (turnId !== previousTurn) runStart = index;
    previousTurn = turnId;
    if (entry.kind === 'pending' || entry.kind === 'artifact') return entry;

    const prior = latest.get(entry.turn.id);
    const reference = prior !== undefined && prior.index < runStart ? prior.message : undefined;
    if (entry.kind === 'user' || entry.kind === 'reply') {
      latest.set(entry.turn.id, {
        index,
        message: {
          messageId: entry.id,
          author: entry.kind === 'user' ? '你' : '助手',
          text: excerpt(entry.kind === 'user' ? userText(entry.turn) : entry.reply.text),
        },
      });
    }
    return entry.kind !== 'user' && reference !== undefined ? { ...entry, reference } : entry;
  });
}

/** Parsed timestamp for ordering; invalid stamps fall back to a stable 0. */
function parseStamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Global chronological order; equal stamps keep their insertion order. */
function sortByAt(entries: MessageTimelineEntry[]): MessageTimelineEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => parseStamp(a.entry.at) - parseStamp(b.entry.at) || a.index - b.index)
    .map((item) => item.entry);
}

/**
 * Flatten the folded turns and optimistic pending turns into independent
 * message rows: every user message, every committed reply, a terminal fallback
 * for an ended turn without replies and every completed dispatch that produced
 * files. Rows are ordered by their own timestamp across all concurrent turns.
 */
export function buildMessageTimeline(
  turns: readonly TurnModel[],
  pending: readonly PendingTurn[],
): MessageTimelineEntry[] {
  const entries: MessageTimelineEntry[] = [];
  for (const turn of turns) {
    entries.push({ kind: 'user', id: `user:${turn.id}`, at: turn.user.at, turn });
    turn.replies.forEach((reply, index) => {
      entries.push({ kind: 'reply', id: `reply:${turn.id}:${index}:${reply.at}`, at: reply.at, turn, reply });
    });
    if (turn.replies.length === 0 && turn.status !== 'running') {
      entries.push({ kind: 'fallback', id: `fallback:${turn.id}`, at: turn.endedAt ?? turn.startedAt, turn });
    }
    for (const action of turn.actions) {
      if (action.kind === 'dispatch' && action.status === 'done' && (action.files?.length ?? 0) > 0) {
        entries.push({
          kind: 'artifact',
          id: `artifact:${turn.id}:${action.id}`,
          at: action.endedAt ?? action.startedAt,
          turn,
          action,
        });
      }
    }
  }
  for (const item of pending) {
    entries.push({ kind: 'pending', id: `pending:${item.localId}`, at: item.at, pending: item });
  }
  return withReplyReferences(sortByAt(entries));
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Divider label before a row, or `undefined` when none belongs there. A divider
 * opens the conversation, then appears after a 15 minute gap or a local
 * calendar day change; invalid stamps never produce a divider.
 */
function dividerLabelFor(at: string, previousAt: string | undefined, now: number): string | undefined {
  const current = Date.parse(at);
  if (!Number.isFinite(current)) return undefined;
  if (previousAt === undefined) return formatDivider(at, now);
  const previous = Date.parse(previousAt);
  if (!Number.isFinite(previous)) return undefined;
  if (current - previous >= DIVIDER_GAP_MS) return formatDivider(at, now);
  if (startOfLocalDay(previous) !== startOfLocalDay(current)) return formatDivider(at, now);
  return undefined;
}

/** Completed dispatch result card, matching the previous per-turn design. */
function DispatchFileCard({ action, sessionId }: { action: ActionModel; sessionId: string }) {
  return (
    <div className="flex flex-col gap-2 pl-10">
      <div className="rounded-xl border bg-muted/40 px-2.5 py-2">
        <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className="truncate">{action.task?.taskName ?? action.title}</span>
          {action.taskRunId !== undefined && (
            <button
              type="button"
              className="shrink-0 underline-offset-2 hover:underline"
              onClick={() => { void shell.openTaskTranscript(action.taskRunId!); }}
            >
              查看任务
            </button>
          )}
        </div>
        <MediaAttachments items={action.files!.map(fromSessionFile)} sessionId={sessionId} />
      </div>
    </div>
  );
}

interface EntryContext {
  sessionId?: string;
  enter: boolean;
  onRetry: (text: string, attachments: DraftAttachment[]) => void;
  onRemove: (localId: string) => void;
  onJump: (messageId: string) => void;
  onReply: (quote: string) => void;
}

/** The body of one timeline row, without its scroller item or divider. */
function EntryContent({ entry, sessionId, enter, onRetry, onRemove, onJump, onReply }: EntryContext & { entry: MessageTimelineEntry }) {
  switch (entry.kind) {
    case 'user': {
      const attachments = (entry.turn.user.attachments ?? []).map(fromSessionFile);
      return (
        <UserMessage
          text={entry.turn.user.text}
          at={entry.turn.user.at}
          enter={enter}
          onReply={() => onReply(excerpt(userText(entry.turn)))}
          {...(attachments.length > 0 ? { attachments } : {})}
          {...(sessionId === undefined ? {} : { sessionId })}
        />
      );
    }
    case 'pending': {
      const attachments = (entry.pending.attachments ?? []).map(fromDraftAttachment);
      return (
        <UserMessage
          text={entry.pending.text}
          at={entry.pending.at}
          pending={entry.pending}
          enter={enter}
          {...(attachments.length > 0 ? { attachments } : {})}
          onRetry={() => { onRetry(entry.pending.text, entry.pending.attachments ?? []); onRemove(entry.pending.localId); }}
        />
      );
    }
    case 'reply':
      return (
        <AssistantMessage
          turn={entry.turn}
          reply={entry.reply}
          enter={enter}
          onReply={() => onReply(excerpt(entry.reply.text))}
          {...(entry.reference === undefined ? {} : {
            reference: { ...entry.reference, onJump: () => onJump(entry.reference!.messageId) },
          })}
        />
      );
    case 'fallback':
      return (
        <AssistantMessage
          turn={entry.turn}
          enter={enter}
          {...(entry.reference === undefined ? {} : {
            reference: { ...entry.reference, onJump: () => onJump(entry.reference!.messageId) },
          })}
        />
      );
    case 'artifact':
      return sessionId === undefined ? null : <DispatchFileCard action={entry.action} sessionId={sessionId} />;
  }
}

export interface MessageTimelineProps {
  /** Independent message rows, already ordered chronologically. */
  timeline: readonly MessageTimelineEntry[];
  /** Folded turns; used to append typing indicators while writing replies. */
  turns: readonly TurnModel[];
  /** Ledger session id, used to resolve attachment media. */
  sessionId?: string;
  /** Entry ids appended after the conversation settled, for enter animations. */
  freshMessageKeys: ReadonlySet<string>;
  onRetry: (text: string, attachments: DraftAttachment[]) => void;
  onRemove: (localId: string) => void;
  onReply: (quote: string) => void;
}

/**
 * Message-level conversation: one row per user message, reply, fallback and
 * artifact result across all turns, with time dividers and bottom typing
 * indicators only while replies are being written.
 */
export const MessageTimeline = memo(function MessageTimeline({
  timeline,
  turns,
  sessionId,
  freshMessageKeys,
  onRetry,
  onRemove,
  onReply,
}: MessageTimelineProps) {
  const now = useNow();

  const replyingTurns = turns.filter(isWritingReply);
  const jumpToMessage = (messageId: string): void => {
    // Resolve inside this conversation, even when other session pages exist.
    document.getElementById(`session-message:${sessionId ?? 'draft'}:${messageId}`)
      ?.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  return (
    <>
      {timeline.map((entry, index) => {
        const previous = index > 0 ? timeline[index - 1] : undefined;
        const divider = dividerLabelFor(entry.at, previous?.at, now);
        const turnId = entry.kind === 'pending' ? undefined : entry.turn.id;
        return (
          <MessageScrollerItem
            key={entry.id}
            messageId={entry.id}
            id={`session-message:${sessionId ?? 'draft'}:${entry.id}`}
            data-turn-id={turnId}
            className="flex flex-col gap-2"
          >
            {divider !== undefined && <TimeDivider label={divider} />}
            <EntryContent
              entry={entry}
              sessionId={sessionId}
              enter={freshMessageKeys.has(entry.id)}
              onRetry={onRetry}
              onRemove={onRemove}
              onJump={jumpToMessage}
              onReply={onReply}
            />
          </MessageScrollerItem>
        );
      })}
      {replyingTurns.map((turn) => (
        <MessageScrollerItem
          key={`typing:${turn.id}`}
          messageId={`typing:${turn.id}`}
          data-turn-id={turn.id}
          className="flex flex-col gap-4"
        >
          <TurnStatus turn={turn} />
        </MessageScrollerItem>
      ))}
    </>
  );
});
