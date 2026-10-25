import { useQuery } from '@tanstack/react-query';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { cn } from 'cn';
import { AppMarkdown } from '@/renderer/components/app-markdown';
import { MessageFooter } from '@/renderer/components/chat/MessageFooter';
import { PromptInput } from '@/renderer/components/chat/prompt-input';
import { Page, PageActions, PageContent, PageHeader, PageTitle } from '@/renderer/components/page';
import { QueryError } from '@/renderer/components/query-error';
import { StatusBadge } from '@/renderer/components/status-badge';
import type { StatusTone } from '@/renderer/components/status-badge';
import { Badge } from '@/renderer/components/ui/badge';
import { Bubble, BubbleContent } from '@/renderer/components/ui/bubble';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import { Field, FieldLabel } from '@/renderer/components/ui/field';
import { Input } from '@/renderer/components/ui/input';
import { Item, ItemContent, ItemMedia, ItemTitle } from '@/renderer/components/ui/item';
import { Message, MessageContent, MessageHeader } from '@/renderer/components/ui/message';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/renderer/components/ui/message-scroller';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { useRemoteConnection } from '@/renderer/lib/desktop';
import { navigate } from '@/renderer/lib/navigation';
import { preferencesQuery } from '@/renderer/lib/queries';
import type { AgentBot, AgentBotLocation, AgentStatus, GroupMessage } from '@/shell-contract';
import { fold } from '../session/model/fold.js';
import { MessageTimeline, buildMessageTimeline } from '../session/components/conversation/MessageTimeline.js';
import type { GroupTranscript } from './queries.js';
import {
  useAgentEvents,
  useAgentsQuery,
  useCreateAgentMutation,
  useGroupEvents,
  useGroupSendMutation,
  useWakeMutation,
} from './queries.js';

const PAGE_TITLE = '机器人';

/** Chinese label and tone of every bot status. */
const STATUS_VIEW: Record<AgentStatus, { label: string; tone: StatusTone }> = {
  idle: { label: '空闲', tone: 'muted' },
  running: { label: '运行中', tone: 'running' },
  error: { label: '错误', tone: 'danger' },
  disabled: { label: '已停用', tone: 'warning' },
};

/** The immutable id rule the daemon enforces, checked live in the wizard. */
const BOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;
/** Name a freshly created bot starts with. */
const DEFAULT_BOT_NAME = '助手';
/** Where a new bot may live; the workspace is the default. */
const LOCATION_OPTIONS: ReadonlyArray<{ value: AgentBotLocation; label: string }> = [
  { value: 'workspace', label: 'Workspace（多设备同步）' },
  { value: 'device', label: '仅本机' },
];

/** Where one definition lives, as the list shows it. */
function locationText(location: AgentBotLocation): string {
  return location === 'workspace' ? 'Workspace' : '本机';
}

/** The icon of one bot: its identity icon, else the first character of its name. */
function botIcon(bot: AgentBot): string {
  const icon = bot.icon?.trim();
  if (icon !== undefined && icon !== '') return icon;
  return [...bot.name.trim()][0] ?? bot.id.slice(0, 1);
}

/** The list as Desktop renders it: the primary bot first, then by id. */
function sortBots(bots: readonly AgentBot[]): AgentBot[] {
  return [...bots].sort((left, right) => {
    if (left.primary !== right.primary) return left.primary ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}

/* ------------------------------------------------------------------ */
/* Shared bot rows: mention picker and header roster                   */
/* ------------------------------------------------------------------ */

/** Roster order for the picker and header list: primary, enabled by name, disabled. */
function orderForPicker(bots: readonly AgentBot[]): AgentBot[] {
  return [...bots].sort((left, right) => {
    if (left.primary !== right.primary) return left.primary ? -1 : 1;
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

/** Dot color for a bot's live status; `disabled` is handled by the row itself. */
const STATUS_DOT: Record<AgentStatus, { className: string; label: string | null }> = {
  idle: { className: 'bg-muted-foreground/50', label: null },
  running: { className: 'bg-primary', label: '工作中' },
  error: { className: 'bg-destructive', label: null },
  disabled: { className: 'bg-muted-foreground/50', label: null },
};

/** 20 px round avatar: the identity icon, else the first letter of the name. */
function BotAvatar(props: { bot: AgentBot; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] leading-none text-muted-foreground',
        props.className,
      )}
    >
      {botIcon(props.bot)}
    </span>
  );
}

/** The status dot at the right end of a bot row, with its label when it has one. */
function BotStatusDot(props: { bot: AgentBot }) {
  const bot = props.bot;
  if (!bot.enabled) {
    return <span className="shrink-0 text-xs text-muted-foreground">已停用</span>;
  }
  const status = STATUS_DOT[bot.status];
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {status.label !== null && (
        <span className="text-xs text-muted-foreground">{status.label}</span>
      )}
      <span aria-hidden className={cn('size-1.5 rounded-full', status.className)} />
    </span>
  );
}

/**
 * The shared bot row content: avatar, name with a muted @id, an optional
 * one-line description and the status at the right end.
 */
function BotRowContent(props: { bot: AgentBot; onOpenSettings?: (id: string) => void }) {
  const bot = props.bot;
  const label = (
    <>
      <BotAvatar bot={bot} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate">{bot.name}</span>
          <span className="truncate text-xs text-muted-foreground">{`@${bot.id}`}</span>
        </span>
        {bot.description !== undefined && bot.description.trim() !== '' && (
          <span className="truncate text-xs text-muted-foreground">{bot.description.trim()}</span>
        )}
      </span>
    </>
  );
  return (
    <>
      {props.onOpenSettings === undefined ? (
        label
      ) : (
        <button
          type="button"
          aria-label={`打开 ${bot.name} 的设置`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left hover:bg-muted"
          onClick={() => props.onOpenSettings?.(bot.id)}
        >
          {label}
        </button>
      )}
      <BotStatusDot bot={bot} />
    </>
  );
}

/**
 * The `@token` the caret currently sits inside, when the `@` starts the draft
 * or follows whitespace. Returns the token's range and filter text, or null.
 */
function mentionTokenAt(text: string, caret: number): { start: number; end: number; filter: string } | null {
  if (caret < 0 || caret > text.length) return null;
  const at = text.lastIndexOf('@', caret - 1);
  if (at < 0) return null;
  const before = at === 0 ? '' : text[at - 1]!;
  if (before !== '' && !/\s/u.test(before)) return null;
  const token = text.slice(at + 1, caret);
  if (/\s/u.test(token)) return null;
  return { start: at, end: caret, filter: token };
}

/** Case-insensitive prefix of the id or the name. */
function botMatchesFilter(bot: AgentBot, filter: string): boolean {
  const key = filter.trim().toLowerCase();
  if (key === '') return true;
  return bot.id.toLowerCase().startsWith(key) || bot.name.trim().toLowerCase().startsWith(key);
}

/**
 * Replace `range` in the draft with `@<id> `, then focus the textarea and put
 * the caret after the inserted token.
 */
function insertMentionAt(
  draft: string,
  range: { start: number; end: number } | null,
  id: string,
  textarea: HTMLTextAreaElement | null,
  onDraftChange: (value: string) => void,
): void {
  const token = `@${id} `;
  let next: string;
  let caret: number;
  if (range !== null) {
    next = `${draft.slice(0, range.start)}${token}${draft.slice(range.end)}`;
    caret = range.start + token.length;
  } else {
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    const before = draft.slice(0, start);
    const previous = before.at(-1);
    const separator = before !== '' && previous !== undefined && !/\s/u.test(previous) ? ' ' : '';
    next = `${before}${separator}${token}${draft.slice(end)}`;
    caret = before.length + separator.length + token.length;
  }
  onDraftChange(next);
  window.requestAnimationFrame(() => {
    textarea?.focus();
    textarea?.setSelectionRange(caret, caret);
  });
}

/**
 * Why the typed id cannot be created. The daemon keeps the authoritative,
 * race-safe check on `agent.create`; this only keeps the form honest before a
 * submit and explains the clash the daemon reports.
 */
function idProblem(id: string, takenIds: readonly string[]): string | null {
  const value = id.trim();
  if (value === '') return '请填写 id';
  if (!BOT_ID_PATTERN.test(value)) return 'id 只能由小写字母、数字和连字符组成，以字母或数字开头，最长 32 个字符';
  if (takenIds.includes(value)) return '这个 id 已经被占用';
  return null;
}

/**
 * The onboarding wizard: shown only when both definition roots loaded and
 * neither holds a bot. It creates one bot through `agent.create` — the renderer
 * never writes a definition file — and hands the created bot back so the page
 * can open its private conversation.
 */
function OnboardingWizard(props: { takenIds: readonly string[]; onCreated: (bot: AgentBot) => void }) {
  const create = useCreateAgentMutation();
  const [id, setId] = useState('');
  const [name, setName] = useState(DEFAULT_BOT_NAME);
  const [icon, setIcon] = useState('');
  const [location, setLocation] = useState<AgentBotLocation>('workspace');

  const problem = idProblem(id, props.takenIds);
  const nameProblem = name.trim() === '' ? '请填写名称' : null;
  const blocked = problem !== null || nameProblem !== null;

  const submit = (): void => {
    // One in-flight create only: a second submit cannot reach the daemon.
    if (create.isPending || blocked) return;
    create.mutate(
      {
        id: id.trim(),
        name: name.trim(),
        ...(icon.trim() === '' ? {} : { icon: icon.trim() }),
        location,
      },
      { onSuccess: (result) => props.onCreated(result.bot) },
    );
  };

  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>创建第一个机器人</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            还没有机器人。创建的主机器人会用一段引导对话开始工作；id 创建后不可修改。
          </p>
          <Field>
            <FieldLabel>id</FieldLabel>
            <Input
              value={id}
              placeholder="assistant"
              aria-invalid={problem !== null}
              onChange={(event) => setId(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">创建后不可修改</span>
            {id.trim() !== '' && problem !== null && (
              <span className="text-xs text-destructive">{problem}</span>
            )}
          </Field>
          <Field>
            <FieldLabel>名称</FieldLabel>
            <Input
              value={name}
              aria-invalid={nameProblem !== null}
              onChange={(event) => setName(event.target.value)}
            />
            {nameProblem !== null && <span className="text-xs text-destructive">{nameProblem}</span>}
          </Field>
          <Field>
            <FieldLabel>图标（可选）</FieldLabel>
            <Input
              value={icon}
              placeholder="🤖"
              className="w-24"
              onChange={(event) => setIcon(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>位置</FieldLabel>
            <div className="flex flex-col gap-1">
              {LOCATION_OPTIONS.map((option) => (
                <label key={option.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="bot-location"
                    value={option.value}
                    checked={location === option.value}
                    onChange={() => setLocation(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </Field>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={create.isPending || blocked} onClick={submit}>
              创建
            </Button>
            {create.isPending && <span className="text-xs text-muted-foreground">创建中…</span>}
          </div>
          <div className="text-xs" aria-live="polite">
            {create.isError && (
              <span className="text-destructive">{`创建失败：${String(create.error)}`}</span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

type ConversationMode = 'group' | 'private';

/** The group/private switch in the compact header. */
function ModeSwitch(props: { mode: ConversationMode; onChange: (mode: ConversationMode) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-full border p-0.5" role="group" aria-label="对话模式">
      <Button
        variant={props.mode === 'group' ? 'secondary' : 'ghost'}
        size="xs"
        aria-pressed={props.mode === 'group'}
        onClick={() => props.onChange('group')}
      >
        群聊
      </Button>
      <Button
        variant={props.mode === 'private' ? 'secondary' : 'ghost'}
        size="xs"
        aria-pressed={props.mode === 'private'}
        onClick={() => props.onChange('private')}
      >
        私聊
      </Button>
    </div>
  );
}

/** One group entry, in the same shape as a session transcript message. */
const GroupMessageView = memo(function GroupMessageView(props: { message: GroupMessage }) {
  const message = props.message;
  const fromUser = message.author === 'user';
  const botId = message.botId;
  const author = message.name ?? botId ?? '机器人';
  return (
    <Message className="group/msg" align={fromUser ? 'end' : 'start'}>
      <MessageContent>
        {!fromUser && (
          <MessageHeader>
            <span className="truncate text-primary" title={botId}>
              {author}
            </span>
          </MessageHeader>
        )}
        {fromUser && <span className="self-end px-1 text-xs text-muted-foreground">你</span>}
        <Bubble variant={fromUser ? 'default' : 'muted'} align={fromUser ? 'end' : 'start'}>
          <BubbleContent className="rounded-2xl px-3 py-1.5">
            <AppMarkdown>{message.text}</AppMarkdown>
          </BubbleContent>
        </Bubble>
        <MessageFooter align={fromUser ? 'right' : 'left'} at={message.at} text={message.text} />
      </MessageContent>
    </Message>
  );
});

/** The canonical group transcript, rendered from the daemon's sequence cursor. */
function GroupTranscriptView(props: {
  transcript: GroupTranscript;
  /** Whether the loaded bot list is empty, so the empty state can offer to create one. */
  noBots: boolean;
  /** Bots woken by a send in this window that are still working. */
  working: ReadonlyArray<{ id: string; name: string }>;
}) {
  const { messages, error, ready } = props.transcript;

  const header = error !== null && (
    <div className="mx-4 mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      {`群聊加载失败：${error}`}
    </div>
  );

  if (!ready && messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="flex flex-col gap-3 p-4" role="status" aria-label="加载群聊">
          <Skeleton className="h-14 w-3/4" />
          <Skeleton className="h-14 w-2/3" />
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="flex min-h-0 flex-1 items-center justify-center">
          {props.noBots ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>还没有机器人</EmptyTitle>
                <EmptyDescription>创建一个机器人，然后在群聊里用 @ 唤醒它。</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  size="sm"
                  onClick={() => { void navigate('settings', { category: 'bot' }); }}
                >
                  创建机器人
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>还没有群聊消息</EmptyTitle>
                <EmptyDescription>在下方发言，用 @机器人 唤醒它。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <MessageScrollerProvider autoScroll>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport className="scroll-fade-y">
            <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-5 px-4 py-4">
              {messages.slice(-200).map((message) => (
                <GroupMessageView key={message.seq} message={message} />
              ))}
              {props.working.map((bot) => (
                <div
                  key={bot.id}
                  role="status"
                  aria-label={`${bot.name} 正在输入…`}
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <span className="font-medium">{bot.name}</span>
                  <span>正在输入…</span>
                  <span className="flex items-center gap-1" aria-hidden>
                    <span className="motion-typing-dot size-2 rounded-full bg-muted-foreground" style={{ animationDelay: '0ms' }} />
                    <span className="motion-typing-dot size-2 rounded-full bg-muted-foreground" style={{ animationDelay: '160ms' }} />
                    <span className="motion-typing-dot size-2 rounded-full bg-muted-foreground" style={{ animationDelay: '320ms' }} />
                  </span>
                </div>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
}

/**
 * The @ mention picker: a non-modal popover anchored to the composer, listing
 * every configured bot in roster order. Open while the caret sits in an
 * `@token`; the token text is the prefix filter. Keys stay in the textarea:
 * a native capture listener decides before React's submit handling sees them.
 */
function MentionPicker(props: {
  bots: readonly AgentBot[];
  botsLoaded: boolean;
  draft: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<{ start: number; filter: string } | null>(null);
  const [selected, setSelected] = useState(0);
  // Latest values for the native listeners; React state setters stay fresh.
  const draftRef = useRef(props.draft);
  draftRef.current = props.draft;
  const activeRef = useRef(active);
  activeRef.current = active;
  const openRef = useRef(open);
  openRef.current = open;
  const botsRef = useRef(props.bots);
  botsRef.current = props.bots;

  const rows = useMemo(
    () => orderForPicker(props.bots).filter((bot) => active !== null && botMatchesFilter(bot, active.filter)),
    [props.bots, active],
  );
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selectable = rows.filter((bot) => bot.enabled);
  const selectedBot = selectable[selected];

  // Recompute the token under the caret; closes when the caret leaves it.
  const syncCaret = (): void => {
    const el = props.textareaRef.current;
    if (el === null) return;
    const token = mentionTokenAt(el.value, el.selectionStart ?? 0);
    if (token === null || el.selectionEnd !== token.end) {
      activeRef.current = null;
      setActive(null);
      openRef.current = false;
      setOpen(false);
      return;
    }
    activeRef.current = token;
    setActive(token);
    openRef.current = true;
    setOpen(true);
  };

  const insert = (bot: AgentBot): void => {
    const token = activeRef.current;
    insertMentionAt(
      draftRef.current,
      token === null ? null : { start: token.start, end: token.start + 1 + token.filter.length },
      bot.id,
      props.textareaRef.current,
      props.onDraftChange,
    );
    activeRef.current = null;
    setActive(null);
    openRef.current = false;
    setOpen(false);
  };

  const selectedRef = useRef(0);
  selectedRef.current = selected;

  // Arrow / Enter / Tab / Esc handling on the textarea, in capture phase so an
  // open picker consumes the keys before the composer submits on Enter.
  useEffect(() => {
    const el = props.textareaRef.current;
    if (el === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!openRef.current) return;
      if (event.isComposing || event.keyCode === 229) return;
      const list = rowsRef.current.filter((bot) => bot.enabled);
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (list.length === 0) return;
          setSelected((previous) => {
            const size = list.length;
            const next = event.key === 'ArrowDown' ? previous + 1 : previous - 1;
            return ((next % size) + size) % size;
          });
          return;
        }
        case 'Enter':
        case 'Tab': {
          const target = list[selectedRef.current] ?? list[0];
          if (target === undefined) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          insert(target);
          return;
        }
        case 'Escape': {
          // Closes only the popover; the draft and the page are untouched.
          event.preventDefault();
          event.stopImmediatePropagation();
          activeRef.current = null;
          setActive(null);
          openRef.current = false;
          setOpen(false);
          return;
        }
        default:
      }
    };
    const onInput = (): void => syncCaret();
    const onSelect = (): void => syncCaret();
    const onBlur = (): void => {
      // Focus leaving the composer closes the picker. Clicks inside the popup
      // move focus there only after the insert already ran on pointerdown.
      activeRef.current = null;
      setActive(null);
      openRef.current = false;
      setOpen(false);
    };
    el.addEventListener('keydown', onKeyDown, { capture: true });
    el.addEventListener('input', onInput);
    el.addEventListener('select', onSelect);
    el.addEventListener('blur', onBlur);
    return () => {
      el.removeEventListener('keydown', onKeyDown, { capture: true });
      el.removeEventListener('input', onInput);
      el.removeEventListener('select', onSelect);
      el.removeEventListener('blur', onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs keep the latest values; one binding is enough.
  }, [props.textareaRef]);

  // The first selectable row starts selected whenever the filter changes.
  useEffect(() => { setSelected(0); }, [active?.filter]);

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      {/* Invisible composer-wide trigger: the anchor the popup measures and
          positions against, so the picker opens above at composer width. */}
      <PopoverTrigger
        render={<span className="pointer-events-none absolute inset-x-0 top-0 h-0" aria-hidden />}
      />
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-(--anchor-width) max-w-(--anchor-width) gap-0 rounded-2xl p-1"
        initialFocus={false}
        finalFocus={false}
      >
        {props.bots.length === 0 && props.botsLoaded ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">还没有机器人</div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">没有匹配的机器人</div>
        ) : (
          rows.map((bot) => {
            const isSelected = bot.enabled && bot.id === selectedBot?.id;
            return (
              <button
                key={bot.id}
                type="button"
                disabled={!bot.enabled}
                className={cn(
                  'flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm',
                  bot.enabled ? 'hover:bg-muted' : 'cursor-default opacity-50',
                  isSelected && 'bg-muted',
                )}
                // Pointerdown keeps the textarea's blur from racing the click.
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => { if (bot.enabled) insert(bot); }}
              >
                <BotRowContent bot={bot} />
              </button>
            );
          })
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The group composer and its @ mention picker; wake results land in the transcript. */
function GroupComposer(props: {
  agents: ReturnType<typeof useAgentsQuery>;
  bots: readonly AgentBot[];
  transcript: GroupTranscript;
  draft: string;
  onDraftChange: (value: string) => void;
  /** Imperative insert target shared with the header roster's @ action. */
  insertRef: React.RefObject<((bot: AgentBot) => void) | null>;
  /** Records the bots woken by the send and its transcript seq. */
  onAwakened: (ids: readonly string[], seq: number) => void;
}) {
  const connection = useRemoteConnection();
  const connected = connection.state === 'local' || connection.state === 'remote';
  const preferences = useQuery(preferencesQuery);
  const send = useGroupSendMutation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Shared insert helper: the roster's @ action uses the same caret path.
  props.insertRef.current = (bot: AgentBot): void => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? props.draft.length;
    const token = el === null ? null : mentionTokenAt(props.draft, caret);
    insertMentionAt(props.draft, token, bot.id, el, props.onDraftChange);
  };

  const submit = (): void => {
    const text = props.draft.trim();
    if (text === '' || send.isPending || !connected) return;
    send.mutate(text, {
      onSuccess: (result) => {
        // Only a confirmed daemon post clears the draft; a failure keeps it.
        props.onDraftChange('');
        props.onAwakened(result.awakened, result.message.seq);
        // Read the canonical transcript now instead of waiting for the tick.
        props.transcript.refresh();
      },
    });
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      {props.agents.isError && (
        <div className="mb-2">
          <QueryError query={props.agents} title={PAGE_TITLE} />
        </div>
      )}
      <div className="relative">
        <PromptInput
          value={props.draft}
          onValueChange={props.onDraftChange}
          onSubmit={submit}
          sendKey={preferences.data?.session.sendKey ?? 'enter'}
          submitDisabled={send.isPending || !connected}
          placeholder="发消息，输入 @ 唤醒机器人"
          textareaRef={textareaRef}
        />
        <MentionPicker
          bots={props.bots}
          botsLoaded={!props.agents.isPending}
          draft={props.draft}
          textareaRef={textareaRef}
          onDraftChange={props.onDraftChange}
        />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" aria-live="polite">
        {!connected && <span className="text-destructive">尚未连接，暂时不能发送。</span>}
        {send.isPending && <span className="text-muted-foreground">发送中…</span>}
        {send.isError && (
          <span className="text-destructive">{`发送失败：${String(send.error)}（草稿已保留）`}</span>
        )}
      </div>
    </div>
  );
}

/** Group mode: canonical transcript plus the group composer. */
function GroupView(props: {
  agents: ReturnType<typeof useAgentsQuery>;
  bots: readonly AgentBot[];
  draft: string;
  onDraftChange: (value: string) => void;
  insertRef: React.RefObject<((bot: AgentBot) => void) | null>;
}) {
  const transcript = useGroupEvents();
  // Woken bots still working, in wake order; `since` excludes earlier replies.
  const [working, setWorking] = useState<ReadonlyArray<{ id: string; since: number }>>([]);
  // Bots seen running or queued since their send; an idle poll only clears one
  // that actually started, never a wake the daemon has not admitted yet.
  const seenActive = useRef(new Set<string>());

  const onAwakened = (ids: readonly string[], seq: number): void => {
    setWorking((previous) => {
      const next = [...previous];
      for (const id of ids) {
        const index = next.findIndex((entry) => entry.id === id);
        if (index === -1) next.push({ id, since: seq });
        else next[index] = { id, since: seq };
        seenActive.current.delete(id);
      }
      return next;
    });
  };

  useEffect(() => {
    setWorking((previous) => {
      if (previous.length === 0) return previous;
      const bots = props.agents.data?.bots ?? [];
      const next = previous.filter((entry) => {
        const replied = transcript.messages.some(
          (message) => message.seq > entry.since && message.author === 'bot' && message.botId === entry.id,
        );
        if (replied) {
          seenActive.current.delete(entry.id);
          return false;
        }
        const bot = bots.find((candidate) => candidate.id === entry.id);
        if (bot === undefined) return true;
        if (bot.status === 'running' || bot.queued > 0) {
          seenActive.current.add(entry.id);
          return true;
        }
        if (seenActive.current.has(entry.id)) {
          seenActive.current.delete(entry.id);
          return false;
        }
        return true;
      });
      return next.length === previous.length ? previous : next;
    });
  }, [transcript.messages, props.agents.data]);

  const workingBots = working.map((entry) => ({
    id: entry.id,
    name: props.bots.find((bot) => bot.id === entry.id)?.name ?? entry.id,
  }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GroupTranscriptView
        transcript={transcript}
        noBots={!props.agents.isPending && !props.agents.isError && props.bots.length === 0}
        working={workingBots}
      />
      <div className="shrink-0 border-t bg-background px-4 py-3">
        <GroupComposer
          agents={props.agents}
          bots={props.bots}
          transcript={transcript}
          draft={props.draft}
          onDraftChange={props.onDraftChange}
          insertRef={props.insertRef}
          onAwakened={onAwakened}
        />
      </div>
    </div>
  );
}

/**
 * The header roster button: up to three overlapping avatars plus the count of
 * every configured bot. Its popover lists all bots in picker order with a `@`
 * insert action and a `私聊` action; it has no editing controls.
 */
function RosterButton(props: {
  agents: ReturnType<typeof useAgentsQuery>;
  bots: readonly AgentBot[];
  onMention: (bot: AgentBot) => void;
  onPrivate: (bot: AgentBot) => void;
}) {
  const [open, setOpen] = useState(false);
  const ordered = useMemo(() => orderForPicker(props.bots), [props.bots]);
  const avatars = ordered.slice(0, 3);

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="xs" aria-label="机器人成员" />
        }
      >
        {props.agents.isPending ? (
          <span className="flex items-center gap-1" role="status" aria-label="加载机器人">
            <Skeleton className="size-5 rounded-full" />
            <Skeleton className="h-3 w-12" />
          </span>
        ) : (
          <>
            {avatars.length > 0 && (
              <span className="flex -space-x-1.5">
                {avatars.map((bot) => (
                  <BotAvatar key={bot.id} bot={bot} className="ring-1 ring-background" />
                ))}
              </span>
            )}
            <span>{`${props.bots.length} 个机器人`}</span>
          </>
        )}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-72 gap-0 rounded-2xl p-1">
        {props.bots.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">还没有机器人</div>
        ) : (
          ordered.map((bot) => (
            <div
              key={bot.id}
              className={cn(
                'flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm',
                !bot.enabled && 'opacity-50',
              )}
            >
              <BotRowContent
                bot={bot}
                onOpenSettings={(id) => {
                  setOpen(false);
                  void navigate('settings', { category: 'bot', bot: id });
                }}
              />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`提及 ${bot.name}`}
                title={`提及 ${bot.name}`}
                disabled={!bot.enabled}
                className="shrink-0"
                onClick={() => {
                  setOpen(false);
                  props.onMention(bot);
                }}
              >
                @
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className="shrink-0 px-1.5"
                onClick={() => {
                  setOpen(false);
                  props.onPrivate(bot);
                }}
              >
                私聊
              </Button>
            </div>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Private mode: one bot's own context ledger, folded as before. */
function PrivateConversation(props: { id: string; botNames: ReadonlyMap<string, string> }) {
  const events = useAgentEvents(props.id);
  const model = useMemo(() => fold(events, [], {}, {}), [events]);
  const timeline = useMemo(() => buildMessageTimeline(model.turns, []), [model.turns]);
  const freshKeys = useMemo(() => new Set<string>(), []);
  if (timeline.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>暂无私聊</EmptyTitle>
            <EmptyDescription>发送一条消息唤醒这个机器人。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }
  return (
    <MessageScrollerProvider key={props.id} autoScroll>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport className="scroll-fade-y">
          <MessageScrollerContent className="w-full px-4 py-4">
            <MessageTimeline
              timeline={timeline}
              turns={model.turns}
              botNames={props.botNames}
              freshMessageKeys={freshKeys}
              onRetry={() => {}}
              onRemove={() => {}}
              onReply={() => {}}
            />
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

/** Private composer: wakes only the selected bot. */
function PrivateComposer(props: {
  botId: string;
  enabled: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const wake = useWakeMutation();
  const preferences = useQuery(preferencesQuery);
  const sendKey = preferences.data?.session.sendKey ?? 'enter';
  const send = (): void => {
    const text = props.draft.trim();
    if (text === '' || !props.enabled || wake.isPending) return;
    wake.mutate(
      { id: props.botId, text },
      { onSuccess: () => props.onDraftChange('') },
    );
  };
  return (
    <div className="mx-auto w-full max-w-3xl">
      <PromptInput
        value={props.draft}
        onValueChange={props.onDraftChange}
        onSubmit={send}
        sendKey={sendKey}
        disabled={!props.enabled}
        submitDisabled={wake.isPending}
        placeholder={props.enabled
          ? `给这个机器人发私信（${sendKey === 'mod-enter' ? 'Cmd/Ctrl+Enter' : 'Enter'} 发送）`
          : '机器人已停用，私聊历史仅可查看'}
      />
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" aria-live="polite">
        {wake.isPending && <span className="text-muted-foreground">发送中…</span>}
        {wake.isError && (
          <span className="text-destructive">{`发送失败：${String(wake.error)}（草稿已保留）`}</span>
        )}
      </div>
    </div>
  );
}

/** Private mode: the selected bot's header, history and composer. */
function PrivateView(props: {
  bot: AgentBot;
  botNames: ReadonlyMap<string, string>;
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const status = STATUS_VIEW[props.bot.status];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
        <button
          type="button"
          aria-label={`打开 ${props.bot.name} 的设置`}
          className="flex items-center gap-2 rounded-md hover:bg-muted"
          onClick={() => { void navigate('settings', { category: 'bot', bot: props.bot.id }); }}
        >
          <span aria-hidden>{botIcon(props.bot)}</span>
          <span className="font-medium">{props.bot.name}</span>
        </button>
        <Badge variant="secondary" className="rounded-md font-normal text-muted-foreground">
          {props.bot.id}
        </Badge>
        {props.bot.primary && (
          <Badge variant="secondary" className="rounded-md bg-primary/15 text-primary">
            主
          </Badge>
        )}
        <Badge variant="secondary" className="rounded-md font-normal text-muted-foreground">
          {locationText(props.bot.location)}
        </Badge>
        <StatusBadge tone={status.tone} label={status.label} />
        {!props.bot.enabled && (
          <span className="text-xs text-muted-foreground">已停用，仅可查看历史。</span>
        )}
        {props.bot.warning !== undefined && (
          <span className="flex items-center gap-1 text-xs text-warning">
            <TriangleAlert className="size-3.5 shrink-0" />
            {props.bot.warning}
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PrivateConversation id={props.bot.id} botNames={props.botNames} />
      </div>
      <div className="shrink-0 border-t bg-background px-4 py-3">
        <PrivateComposer
          botId={props.bot.id}
          enabled={props.bot.enabled}
          draft={props.draft}
          onDraftChange={props.onDraftChange}
        />
      </div>
    </div>
  );
}

/**
 * The 机器人 page: a full-height group conversation by default, with a
 * per-bot private conversation alongside it. Both modes read the daemon's own
 * records — the shared transcript through `agent.group.events` and one bot's
 * context ledger through `agent.events` — so the page never reconstructs
 * history. Routines moved to the dedicated 自动化 page; config remains in
 * Settings → 机器人.
 */
export function AgentsPage() {
  const agents = useAgentsQuery();
  const [mode, setMode] = useState<ConversationMode>('group');
  const [privateId, setPrivateId] = useState<string | null>(null);
  const [groupDraft, setGroupDraft] = useState('');
  const [privateDrafts, setPrivateDrafts] = useState<Record<string, string>>({});
  // The group composer registers its mention-insert here for the roster's @.
  const groupInsertRef = useRef<((bot: AgentBot) => void) | null>(null);

  const bots = useMemo(() => sortBots(agents.data?.bots ?? []), [agents.data]);
  const botNames = useMemo(
    () => new Map((agents.data?.bots ?? []).map((bot) => [bot.id, bot.name])),
    [agents.data],
  );

  // Keep a valid private selection as the polled list changes.
  useEffect(() => {
    const list = agents.data?.bots ?? [];
    if (list.length === 0) {
      if (privateId !== null) setPrivateId(null);
      return;
    }
    if (privateId === null || !list.some((bot) => bot.id === privateId)) setPrivateId(list[0]!.id);
  }, [agents.data, privateId]);

  const selected = useMemo(
    () => bots.find((bot) => bot.id === privateId),
    [bots, privateId],
  );

  // Only a loaded, empty list starts onboarding; a loading or failed list never
  // does, so a transient daemon state cannot offer a duplicate create.
  const onboarding = !agents.isError && !agents.isPending && bots.length === 0;

  return (
    <Page data-page="agents">
      <PageHeader>
        <PageTitle>{PAGE_TITLE}</PageTitle>
        <PageActions>
          {mode === 'group' && (
            <RosterButton
              agents={agents}
              bots={bots}
              onMention={(bot) => groupInsertRef.current?.(bot)}
              onPrivate={(bot) => {
                setPrivateId(bot.id);
                setMode('private');
              }}
            />
          )}
          <ModeSwitch mode={mode} onChange={setMode} />
        </PageActions>
      </PageHeader>
      <PageContent fill className="gap-0 p-0">
        {onboarding ? (
          <OnboardingWizard
            takenIds={bots.map((bot) => bot.id)}
            onCreated={(bot) => {
              // The daemon already enqueued the onboarding wake; open the new
              // bot's own conversation instead of repeating it here.
              setPrivateId(bot.id);
              setMode('private');
            }}
          />
        ) : agents.isError && mode === 'private' ? (
          <QueryError query={agents} title={PAGE_TITLE} />
        ) : mode === 'group' ? (
          <GroupView
            agents={agents}
            bots={bots}
            draft={groupDraft}
            onDraftChange={setGroupDraft}
            insertRef={groupInsertRef}
          />
        ) : agents.isPending ? (
          <div className="flex flex-col gap-3 p-4" role="status" aria-label="加载机器人">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : selected === undefined ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>选择一个机器人</EmptyTitle>
              <EmptyDescription>没有可用的机器人配置。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex min-h-0 flex-1">
            <aside
              aria-label="机器人列表"
              className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r p-2 animate-in fade-in slide-in-from-left-2 duration-base ease-out"
            >
              {bots.map((bot) => (
                <Item
                  key={bot.id}
                  size="xs"
                  variant={bot.id === selected.id ? 'muted' : 'default'}
                  render={
                    <button
                      type="button"
                      aria-pressed={bot.id === selected.id}
                      onClick={() => setPrivateId(bot.id)}
                    />
                  }
                  className="cursor-pointer text-left"
                >
                  <ItemMedia>
                    <BotAvatar bot={bot} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle className="min-w-0 truncate">{bot.name}</ItemTitle>
                  </ItemContent>
                  <BotStatusDot bot={bot} />
                  {bot.primary && (
                    <Badge variant="secondary" className="shrink-0 rounded-md bg-primary/15 text-primary">
                      主
                    </Badge>
                  )}
                </Item>
              ))}
            </aside>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <PrivateView
                bot={selected}
                botNames={botNames}
                draft={privateDrafts[selected.id] ?? ''}
                onDraftChange={(value) => setPrivateDrafts((previous) => ({ ...previous, [selected.id]: value }))}
              />
            </div>
          </div>
        )}
      </PageContent>
    </Page>
  );
}
