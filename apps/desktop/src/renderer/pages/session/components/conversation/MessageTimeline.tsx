import { memo, useMemo } from 'react';
import { MessageScrollerItem } from '@/renderer/components/ui/message-scroller';
import { useNow } from '@/renderer/hooks/use-now';
import { formatDivider } from '@/renderer/lib/format';
import { prefersReducedMotion } from '@/renderer/lib/motion';
import { attachmentFileIdentity } from '@/renderer/components/markdown';
import { DIVIDER_GAP_MS } from '../../model/dividers.js';
import { userSpeakerLabel } from '../../model/describe.js';
import type { DraftAttachment, ModelEntry, ReplyModel, SessionFile, TurnModel } from '../../model/types.js';
import type { PendingTurn } from '../../state/session-reducer.js';
import { fromDraftAttachment, fromSessionFile } from '../MediaAttachments.js';
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

export type MessageTimelineEntry =
  | TimelineUserEntry
  | TimelinePendingEntry
  | TimelineReplyEntry;

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
    if (entry.kind === 'pending') return entry;

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

/** Global chronological order; equal stamps keep their insertion order. */
function sortByAt(entries: MessageTimelineEntry[]): MessageTimelineEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => parseStamp(a.entry.at) - parseStamp(b.entry.at) || a.index - b.index)
    .map((item) => item.entry);
}

/**
 * Flatten the folded turns and optimistic pending turns into independent
 * message rows: every user message and every committed reply, including the
 * closing reply a turn derived on read. Task attachments are not appended
 * automatically; a task file appears only where a reply references it. Rows
 * are ordered by their own timestamp across all concurrent turns.
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
  }
  for (const item of pending) {
    entries.push({ kind: 'pending', id: `pending:${item.localId}`, at: item.at, pending: item });
  }
  return withReplyReferences(sortByAt(entries));
}

/**
 * Every task file the whole session produced, deduped by path + hash, so a
 * reply can reference a file from an earlier turn as well as the current one.
 */
function taskAttachmentDirectory(turns: readonly TurnModel[]): SessionFile[] {
  const files = new Map<string, SessionFile>();
  for (const turn of turns) {
    for (const action of turn.actions) {
      for (const file of action.files ?? []) {
        if (file.source !== 'task') continue;
        const identity = attachmentFileIdentity(file);
        if (!files.has(identity)) files.set(identity, file);
      }
    }
  }
  return [...files.values()];
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

interface EntryContext {
  sessionId?: string;
  models?: readonly ModelEntry[];
  attachmentFiles: readonly SessionFile[];
  botNames: ReadonlyMap<string, string>;
  enter: boolean;
  onRetry: (text: string, attachments: DraftAttachment[]) => void;
  onRemove: (localId: string) => void;
  onJump: (messageId: string) => void;
  onReply: (quote: string) => void;
}

/** The body of one timeline row, without its scroller item or divider. */
function EntryContent({ entry, sessionId, models, attachmentFiles, botNames, enter, onRetry, onRemove, onJump, onReply }: EntryContext & { entry: MessageTimelineEntry }) {
  switch (entry.kind) {
    case 'user': {
      const attachments = (entry.turn.user.attachments ?? []).map(fromSessionFile);
      return (
        <UserMessage
          text={entry.turn.user.text}
          at={entry.turn.user.at}
          enter={enter}
          speaker={userSpeakerLabel(entry.turn.user.sender, botNames)}
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
          speaker={userSpeakerLabel(undefined, botNames)}
          {...(attachments.length > 0 ? { attachments } : {})}
          onRetry={() => { onRetry(entry.pending.text, entry.pending.attachments ?? []); onRemove(entry.pending.localId); }}
        />
      );
    }
    case 'reply':
      // Every publication to the user is a full assistant message, intermediate
      // and closing alike. No text is merged or dropped, and every reply
      // resolves the task files it references.
      return (
        <AssistantMessage
          turn={entry.turn}
          reply={entry.reply}
          model={modelDisplayName(reasoningModelId(entry.turn), models)}
          attachmentFiles={attachmentFiles}
          enter={enter}
          onReply={() => onReply(excerpt(entry.reply.text))}
          {...(sessionId === undefined ? {} : { sessionId })}
          {...(entry.reference === undefined ? {} : {
            reference: { ...entry.reference, onJump: () => onJump(entry.reference!.messageId) },
          })}
        />
      );
  }
}

/** Used when a caller has no bot roster: every bot falls back to its raw id. */
const EMPTY_BOT_NAMES: ReadonlyMap<string, string> = new Map();

export interface MessageTimelineProps {
  /** Independent message rows, already ordered chronologically. */
  timeline: readonly MessageTimelineEntry[];
  /** Folded turns; used to append typing indicators while writing replies. */
  turns: readonly TurnModel[];
  /** Ledger session id, used to resolve attachment media. */
  sessionId?: string;
  /** Model catalog, used to show a reply's model display name. */
  models?: readonly ModelEntry[];
  /** Bot id to display name roster; absent entries fall back to the raw id. */
  botNames?: ReadonlyMap<string, string>;
  /** Entry ids appended after the conversation settled, for enter animations. */
  freshMessageKeys: ReadonlySet<string>;
  onRetry: (text: string, attachments: DraftAttachment[]) => void;
  onRemove: (localId: string) => void;
  onReply: (quote: string) => void;
}

/**
 * Message-level conversation: one row per user message, reply and fallback
 * across all turns, with time dividers, bottom typing indicators only while
 * replies are being written, and an activity row for every running turn. Task
 * attachments are never appended on their own; each reply row resolves
 * the files it references against the whole session's task files.
 */
export const MessageTimeline = memo(function MessageTimeline({
  timeline,
  turns,
  sessionId,
  models,
  botNames = EMPTY_BOT_NAMES,
  freshMessageKeys,
  onRetry,
  onRemove,
  onReply,
}: MessageTimelineProps) {
  const now = useNow();
  const attachmentFiles = useMemo(() => taskAttachmentDirectory(turns), [turns]);

  const writingTurns = turns.filter(isWritingReply);
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
              models={models}
              attachmentFiles={attachmentFiles}
              botNames={botNames}
              enter={freshMessageKeys.has(entry.id)}
              onRetry={onRetry}
              onRemove={onRemove}
              onJump={jumpToMessage}
              onReply={onReply}
            />
          </MessageScrollerItem>
        );
      })}
      {writingTurns.map((turn) => (
        <MessageScrollerItem
          key={`typing:${turn.id}`}
          messageId={`typing:${turn.id}`}
          data-turn-id={turn.id}
          className="flex flex-col gap-2"
        >
          <TurnStatus turn={turn} />
        </MessageScrollerItem>
      ))}
    </>
  );
});
