import { useEffect, useMemo, useRef, useState } from 'react';
import { AppMarkdown } from '@/renderer/components/app-markdown';
import { PromptInput } from '@/renderer/components/chat/prompt-input';
import { Page, PageActions, PageContent, PageHeader, PageTitle } from '@/renderer/components/page';
import { QueryError } from '@/renderer/components/query-error';
import { StatusBadge } from '@/renderer/components/status-badge';
import type { StatusTone } from '@/renderer/components/status-badge';
import { Timestamp } from '@/renderer/components/timestamp';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import { Field, FieldLabel } from '@/renderer/components/ui/field';
import { Input } from '@/renderer/components/ui/input';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/renderer/components/ui/message-scroller';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { useRemoteConnection } from '@/renderer/lib/desktop';
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

/** One list line: icon, name, the 主 marker, location and every warning mark. */
function botLabel(bot: AgentBot): string {
  const parts = [botIcon(bot), bot.name];
  if (bot.primary) parts.push('主');
  parts.push(locationText(bot.location));
  if (!bot.enabled) parts.push('已停用');
  if (bot.warning !== undefined) parts.push('⚠');
  return parts.join(' · ');
}

/** The list as Desktop renders it: the primary bot first, then by id. */
function sortBots(bots: readonly AgentBot[]): AgentBot[] {
  return [...bots].sort((left, right) => {
    if (left.primary !== right.primary) return left.primary ? -1 : 1;
    return left.id.localeCompare(right.id);
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

/** Author line shared by every group entry. */
function GroupMessageView(props: { message: GroupMessage }) {
  const message = props.message;
  const fromUser = message.author === 'user';
  const author = fromUser ? '你' : message.name ?? message.botId ?? '机器人';
  return (
    <article className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
        <span className={fromUser ? 'font-medium text-foreground' : 'font-medium text-primary'}>{author}</span>
        {!fromUser && message.botId !== undefined && (
          <span className="rounded bg-muted px-1 tabular-nums">{message.botId}</span>
        )}
        <Timestamp value={message.at} precision="second" />
      </div>
      <div className={`rounded-xl border px-3 py-2 text-sm ${fromUser ? 'bg-muted/40' : 'bg-card'}`}>
        <AppMarkdown>{message.text}</AppMarkdown>
      </div>
    </article>
  );
}

/** The canonical group transcript, rendered from the daemon's sequence cursor. */
function GroupTranscriptView(props: { transcript: GroupTranscript }) {
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
          <Empty>
            <EmptyHeader>
              <EmptyTitle>还没有群聊消息</EmptyTitle>
              <EmptyDescription>在下方发言，用 @机器人 唤醒它。</EmptyDescription>
            </EmptyHeader>
          </Empty>
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
              {messages.map((message) => (
                <GroupMessageView key={message.seq} message={message} />
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
 * Aliases in the draft that name no enabled bot. The daemon resolves mentions
 * itself; this list only lets the composer say plainly that an unknown or
 * disabled alias woke nobody.
 */
function unrecognizedMentions(text: string, bots: readonly AgentBot[]): string[] {
  const enabled = bots.filter((bot) => bot.enabled);
  const nameCounts = new Map<string, number>();
  for (const bot of enabled) {
    const key = bot.name.trim().toLowerCase();
    if (key === '') continue;
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const aliases = new Set<string>();
  for (const bot of enabled) aliases.add(bot.id.toLowerCase());
  for (const bot of enabled) {
    const key = bot.name.trim().toLowerCase();
    if (key !== '' && nameCounts.get(key) === 1) aliases.add(key);
  }
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
    const token = match[1]!;
    const key = token.toLowerCase();
    if (aliases.has(key) || seen.has(key)) continue;
    seen.add(key);
    unknown.push(token);
  }
  return unknown;
}

/** Room in the draft for one unambiguous alias; the caret controls the spot. */
function insertMention(
  draft: string,
  id: string,
  textarea: HTMLTextAreaElement | null,
  onDraftChange: (value: string) => void,
): void {
  const token = `@${id} `;
  const start = textarea?.selectionStart ?? draft.length;
  const end = textarea?.selectionEnd ?? draft.length;
  const before = draft.slice(0, start);
  const previous = before.at(-1);
  const separator = before !== '' && previous !== undefined && !/\s/u.test(previous) ? ' ' : '';
  const next = `${before}${separator}${token}${draft.slice(end)}`;
  onDraftChange(next);
  const caret = before.length + separator.length + token.length;
  window.requestAnimationFrame(() => {
    textarea?.focus();
    textarea?.setSelectionRange(caret, caret);
  });
}

/** The group composer, roster chips and explicit wake feedback. */
function GroupComposer(props: {
  agents: ReturnType<typeof useAgentsQuery>;
  bots: readonly AgentBot[];
  transcript: GroupTranscript;
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const connection = useRemoteConnection();
  const connected = connection.state === 'local' || connection.state === 'remote';
  const send = useGroupSendMutation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);

  const enabledBots = props.bots.filter((bot) => bot.enabled);
  const unknown = unrecognizedMentions(props.draft, props.bots);

  const submit = (): void => {
    const text = props.draft.trim();
    if (text === '' || send.isPending || !connected) return;
    setFeedback(null);
    send.mutate(text, {
      onSuccess: (result) => {
        // Only a confirmed daemon post clears the draft; a failure keeps it.
        props.onDraftChange('');
        const names = result.awakened.map((id) => {
          const name = props.bots.find((bot) => bot.id === id)?.name;
          return name !== undefined && name !== id ? `${name}（${id}）` : id;
        });
        if (result.awakened.length === 0) {
          setFeedback({
            tone: 'warn',
            text: unknown.length > 0
              ? `没有机器人被唤醒：未识别或已停用的提及 ${unknown.map((token) => `@${token}`).join('、')}。`
              : '没有机器人被唤醒：只有 @id 或 @名称 才会唤醒机器人。',
          });
        } else if (unknown.length > 0) {
          setFeedback({
            tone: 'warn',
            text: `已唤醒 ${names.join('、')}；未识别或已停用的提及 ${unknown.map((token) => `@${token}`).join('、')}。`,
          });
        } else {
          setFeedback({ tone: 'ok', text: `已唤醒 ${names.join('、')}` });
        }
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
      <PromptInput
        value={props.draft}
        onValueChange={props.onDraftChange}
        onSubmit={submit}
        sendKey="mod-enter"
        submitDisabled={send.isPending || !connected}
        placeholder="在群聊里发言；用 @机器人 唤醒它（Cmd/Ctrl+Enter 发送）"
        textareaRef={textareaRef}
      />
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>提及</span>
        {props.agents.isPending ? (
          <span className="flex items-center gap-2" role="status" aria-label="加载机器人">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-16" />
          </span>
        ) : props.agents.isError ? null : enabledBots.length === 0 ? (
          <span>没有启用的机器人</span>
        ) : (
          enabledBots.map((bot) => (
            <button
              key={bot.id}
              type="button"
              title={`唤醒 ${bot.name}`}
              className="rounded-full border px-2 py-0.5 text-foreground transition-colors hover:bg-muted"
              onClick={() => insertMention(props.draft, bot.id, textareaRef.current, props.onDraftChange)}
            >
              {`@${bot.id}`}
            </button>
          ))
        )}
        <span className="basis-full">提及会唤醒机器人；未提及的发言只进入群聊，不会唤醒任何机器人。</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" aria-live="polite">
        {!connected && <span className="text-destructive">尚未连接，暂时不能发送。</span>}
        {send.isPending && <span className="text-muted-foreground">发送中…</span>}
        {send.isError && (
          <span className="text-destructive">{`发送失败：${String(send.error)}（草稿已保留）`}</span>
        )}
        {feedback !== null && (
          <span className={feedback.tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
            {feedback.text}
          </span>
        )}
        {unknown.length > 0 && !send.isPending && (
          <span className="text-amber-600 dark:text-amber-400">
            {`未识别或已停用的提及：${unknown.map((token) => `@${token}`).join('、')}`}
          </span>
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
}) {
  const transcript = useGroupEvents();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GroupTranscriptView transcript={transcript} />
      <div className="shrink-0 border-t bg-background px-4 py-3">
        <GroupComposer
          agents={props.agents}
          bots={props.bots}
          transcript={transcript}
          draft={props.draft}
          onDraftChange={props.onDraftChange}
        />
      </div>
    </div>
  );
}

/** Private mode: one bot's own context ledger, folded as before. */
function PrivateConversation(props: { id: string }) {
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
        sendKey="mod-enter"
        disabled={!props.enabled}
        submitDisabled={wake.isPending}
        placeholder={props.enabled
          ? '给这个机器人发私信（Cmd/Ctrl+Enter 发送）'
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
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const status = STATUS_VIEW[props.bot.status];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
        <span aria-hidden>{botIcon(props.bot)}</span>
        <span className="font-medium">{props.bot.name}</span>
        <span className="rounded bg-muted px-1 text-xs text-muted-foreground">{props.bot.id}</span>
        {props.bot.primary && (
          <span className="rounded bg-primary/15 px-1 text-xs text-primary">主</span>
        )}
        <span className="rounded bg-muted px-1 text-xs text-muted-foreground">
          {locationText(props.bot.location)}
        </span>
        <StatusBadge tone={status.tone} label={status.label} />
        {!props.bot.enabled && (
          <span className="text-xs text-muted-foreground">已停用，仅可查看历史。</span>
        )}
        {props.bot.warning !== undefined && (
          <span className="text-xs text-amber-600 dark:text-amber-400">{`⚠ ${props.bot.warning}`}</span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PrivateConversation id={props.bot.id} />
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
 * history. Settings (routines and config) moved to Settings → 机器人.
 */
export function AgentsPage() {
  const agents = useAgentsQuery();
  const [mode, setMode] = useState<ConversationMode>('group');
  const [privateId, setPrivateId] = useState<string | null>(null);
  const [groupDraft, setGroupDraft] = useState('');
  const [privateDrafts, setPrivateDrafts] = useState<Record<string, string>>({});

  const bots = useMemo(() => sortBots(agents.data?.bots ?? []), [agents.data]);

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
          <ModeSwitch mode={mode} onChange={setMode} />
          {mode === 'private' && bots.length > 0 && (
            <Select value={privateId ?? bots[0]?.id ?? ''} onValueChange={(value) => setPrivateId(String(value))}>
              <SelectTrigger size="sm" className="w-56" aria-label="选择机器人">
                <SelectValue>
                  {(value) => {
                    const bot = bots.find((entry) => entry.id === value);
                    return bot === undefined ? String(value) : botLabel(bot);
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {bots.map((bot) => (
                  <SelectItem key={bot.id} value={bot.id}>
                    {botLabel(bot)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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
          <PrivateView
            bot={selected}
            draft={privateDrafts[selected.id] ?? ''}
            onDraftChange={(value) => setPrivateDrafts((previous) => ({ ...previous, [selected.id]: value }))}
          />
        )}
      </PageContent>
    </Page>
  );
}
