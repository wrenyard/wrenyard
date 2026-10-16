import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Page, PageContent, PageDescription, PageHeader, PageTitle } from '@/renderer/components/page';
import { QueryError } from '@/renderer/components/query-error';
import { StatusBadge } from '@/renderer/components/status-badge';
import type { StatusTone } from '@/renderer/components/status-badge';
import { Timestamp } from '@/renderer/components/timestamp';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Checkbox } from '@/renderer/components/ui/checkbox';
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
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/renderer/components/ui/table';
import { Textarea } from '@/renderer/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { useConfirm } from '@/renderer/hooks/use-confirm';
import type { AgentStatus, Routine } from '@/shell-contract';
import { fold } from '../session/model/fold.js';
import { MessageTimeline, buildMessageTimeline } from '../session/components/conversation/MessageTimeline.js';
import {
  ROUTINE_STATE_VIEW,
  deliverText,
  frequencyText,
  useAgentConfigQuery,
  useAgentEvents,
  useAgentsQuery,
  useCreateRoutineMutation,
  useDeleteRoutineMutation,
  useRunRoutineMutation,
  useRoutinesQuery,
  useUpdateRoutineMutation,
  useWakeMutation,
} from './queries.js';

/** One-line placeholder for an absent time. */
const NONE = '—';

const PAGE_TITLE = '机器人';

/** Chinese label and tone of every bot status. */
const STATUS_VIEW: Record<AgentStatus, { label: string; tone: StatusTone }> = {
  idle: { label: '空闲', tone: 'muted' },
  running: { label: '运行中', tone: 'running' },
  error: { label: '错误', tone: 'danger' },
  disabled: { label: '已停用', tone: 'warning' },
};

/** The three tool switches a bot config may declare. */
const TOOL_IDS = ['session', 'todo', 'message'] as const;

/** Left column: the bot list with status, last wake and queue depth. */
function BotList(props: { selectedId: string | null; onSelect: (id: string) => void }) {
  const agents = useAgentsQuery();
  const bots = agents.data?.bots ?? [];

  if (agents.isError) return <QueryError query={agents} title={PAGE_TITLE} />;
  if (agents.isPending) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-label="加载机器人">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (bots.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>没有机器人配置</EmptyTitle>
          <EmptyDescription>在配置目录的 bot-agents/ 下添加 &lt;id&gt;.json。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {bots.map((bot) => {
        const view = STATUS_VIEW[bot.status];
        return (
          <button
            key={bot.id}
            type="button"
            onClick={() => props.onSelect(bot.id)}
            className={`rounded-lg border p-3 text-left transition-colors ${
              props.selectedId === bot.id ? 'border-primary bg-accent' : 'hover:bg-accent/50'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{bot.name}</span>
              <StatusBadge tone={view.tone} label={view.label} />
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{bot.id}</div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
              <span>
                上次唤醒 {bot.lastWakeAt === undefined ? NONE : <Timestamp value={bot.lastWakeAt} />}
              </span>
              <span>{`排队 ${bot.queued}`}</span>
            </div>
            {bot.error !== undefined && <div className="mt-1 text-xs text-destructive">{bot.error}</div>}
          </button>
        );
      })}
    </div>
  );
}

/** The bot conversation: the folded context ledger rendered as messages. */
function Conversation(props: { id: string }) {
  const events = useAgentEvents(props.id);
  const model = useMemo(() => fold(events, [], {}, {}), [events]);
  const timeline = useMemo(() => buildMessageTimeline(model.turns, []), [model.turns]);
  const freshKeys = useMemo(() => new Set<string>(), []);
  return (
    <div className="h-[28rem] max-h-[60vh] overflow-hidden rounded-lg border">
      {timeline.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>暂无对话</EmptyTitle>
            <EmptyDescription>发送一条消息唤醒机器人。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <MessageScrollerProvider key={props.id} autoScroll>
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport className="scroll-fade-y">
              <MessageScrollerContent className="w-full px-3 py-3">
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
      )}
    </div>
  );
}

/** Composer: textarea plus a send button that wakes the bot. */
function Composer(props: { botId: string; botEnabled: boolean }) {
  const [text, setText] = useState('');
  const wake = useWakeMutation();
  const canSend = props.botEnabled && text.trim().length > 0 && !wake.isPending;

  const send = (): void => {
    if (!canSend) return;
    wake.mutate(
      { id: props.botId, text: text.trim() },
      {
        onSuccess: () => setText(''),
        // The error is rendered inline below; keep it out of the console.
        onError: () => {},
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={text}
        rows={3}
        placeholder="发送消息唤醒机器人（Cmd/Ctrl+Enter 发送）"
        disabled={!props.botEnabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex items-center justify-between gap-2">
        {wake.isError ? (
          <span className="text-xs text-destructive">{String(wake.error)}</span>
        ) : (
          <span />
        )}
        <Button size="sm" disabled={!canSend} onClick={send}>
          发送
        </Button>
      </div>
    </div>
  );
}

/** Routines section: the bot's routine table with row actions and a create form. */
function Routines(props: { botId: string; otherBotIds: readonly string[] }) {
  const routines = useRoutinesQuery(props.botId);
  const update = useUpdateRoutineMutation();
  const run = useRunRoutineMutation();
  const remove = useDeleteRoutineMutation();
  const create = useCreateRoutineMutation();
  const confirm = useConfirm();

  const [prompt, setPrompt] = useState('');
  const [interval, setIntervalMinutes] = useState('5');
  const [recurring, setRecurring] = useState(true);
  const [deliver, setDeliver] = useState<string>('none');

  const items: Routine[] = routines.data?.routines ?? [];

  const requestDelete = (item: Routine): void => {
    void confirm({
      title: '删除例行任务？',
      description: '删除后不会再触发。',
      confirmLabel: '删除',
      destructive: true,
    }).then((confirmed) => {
      if (confirmed) remove.mutate(item.id);
    });
  };

  const submit = (): void => {
    const minutes = Math.floor(Number(interval));
    if (prompt.trim().length === 0 || !Number.isFinite(minutes) || minutes < 1 || create.isPending) return;
    create.mutate(
      {
        botId: props.botId,
        prompt: prompt.trim(),
        intervalMinutes: minutes,
        recurring,
        deliver: recurring ? (deliver as Routine['deliver']) : undefined,
      },
      {
        onSuccess: () => {
          setPrompt('');
          setIntervalMinutes('5');
          setRecurring(true);
          setDeliver('none');
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>例行任务</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无例行任务。</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>提示词</TableHead>
                <TableHead>频率</TableHead>
                <TableHead>投递</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>下次运行</TableHead>
                <TableHead>上次错误</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const view = ROUTINE_STATE_VIEW[item.state];
                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Tooltip>
                        <TooltipTrigger render={<span className="block max-w-[16rem] truncate font-medium" />}>
                          {item.prompt}
                        </TooltipTrigger>
                        <TooltipContent>{item.prompt}</TooltipContent>
                      </Tooltip>
                      {item.name !== undefined && (
                        <span className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                          {item.name}
                          <span className="rounded bg-muted px-1">配置</span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {frequencyText(item.intervalMinutes, item.recurring)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{deliverText(item.deliver)}</TableCell>
                    <TableCell>
                      {item.state === 'failed' && item.lastError !== undefined ? (
                        <Tooltip>
                          <TooltipTrigger render={<span className="inline-flex" />}>
                            <StatusBadge tone={view.tone} label={view.label} />
                          </TooltipTrigger>
                          <TooltipContent>{item.lastError}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <StatusBadge tone={view.tone} label={view.label} />
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {item.nextRunAt === undefined ? NONE : <Timestamp value={item.nextRunAt} />}
                    </TableCell>
                    <TableCell className="max-w-[10rem] truncate text-xs text-destructive">
                      {item.lastError ?? NONE}
                    </TableCell>
                    <TableCell>
                      <div className="flex shrink-0 items-center justify-end gap-1">
                        {item.state === 'active' && (
                          <Button variant="ghost" size="xs" disabled={update.isPending} onClick={() => update.mutate({ id: item.id, state: 'paused' })}>
                            暂停
                          </Button>
                        )}
                        {item.state === 'paused' && (
                          <Button variant="ghost" size="xs" disabled={update.isPending} onClick={() => update.mutate({ id: item.id, state: 'active' })}>
                            恢复
                          </Button>
                        )}
                        <Button variant="outline" size="xs" disabled={run.isPending} onClick={() => run.mutate(item.id)}>
                          立即运行
                        </Button>
                        <Button variant="ghost" size="xs" className="text-destructive" disabled={remove.isPending} onClick={() => requestDelete(item)}>
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <Textarea value={prompt} rows={2} placeholder="例行任务提示词" onChange={(event) => setPrompt(event.target.value)} />
          <div className="flex flex-wrap items-center gap-4">
            <Field className="flex items-center gap-2">
              <FieldLabel>间隔（分钟）</FieldLabel>
              <Input
                type="number"
                min={1}
                value={interval}
                className="w-24"
                onChange={(event) => setIntervalMinutes(event.target.value)}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={recurring} onCheckedChange={(checked) => setRecurring(checked === true)} />
              重复
            </label>
            <Field className="flex items-center gap-2">
              <FieldLabel>投递</FieldLabel>
              <select
                value={deliver}
                disabled={!recurring}
                className="rounded-md border bg-transparent px-2 py-1 text-sm"
                onChange={(event) => setDeliver(event.target.value)}
              >
                <option value="none">不投递</option>
                {props.otherBotIds.map((id) => (
                  <option key={id} value={`bot:${id}`}>{id}</option>
                ))}
              </select>
            </Field>
            <Button size="sm" className="ml-auto" disabled={create.isPending} onClick={submit}>
              新建
            </Button>
          </div>
          {create.isError && <span className="text-xs text-destructive">{String(create.error)}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

/** Config section: path, tool chips and the read-only config JSON. */
function ConfigSection(props: { botId: string; configPath: string; tools: readonly string[] }) {
  const config = useAgentConfigQuery(props.botId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>配置</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="text-xs text-muted-foreground">{props.configPath}</div>
        <div className="flex items-center gap-2">
          {TOOL_IDS.map((tool) => {
            const on = props.tools.includes(tool);
            return (
              <span key={tool} className={`rounded-full px-2 py-0.5 text-xs ${on ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}>
                {`${tool} ${on ? '开' : '关'}`}
              </span>
            );
          })}
        </div>
        <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs">
          {config.data?.config ?? '…'}
        </pre>
      </CardContent>
    </Card>
  );
}

/** The 机器人 page: bot list, conversation, composer, routines and config. */
export function AgentsPage() {
  const agents = useAgentsQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Keep a valid selection as the polled list changes.
  useEffect(() => {
    const bots = agents.data?.bots ?? [];
    if (bots.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !bots.some((bot) => bot.id === selectedId)) setSelectedId(bots[0]!.id);
  }, [agents.data, selectedId]);

  const selected = useMemo(
    () => (agents.data?.bots ?? []).find((bot) => bot.id === selectedId),
    [agents.data, selectedId],
  );
  const otherBotIds = useMemo(
    () => (agents.data?.bots ?? []).filter((bot) => bot.id !== selectedId).map((bot) => bot.id),
    [agents.data, selectedId],
  );

  return (
    <Page data-page="agents">
      <PageHeader>
        <PageTitle>{PAGE_TITLE}</PageTitle>
        <PageDescription>{`共 ${agents.data?.bots.length ?? 0} 个机器人`}</PageDescription>
      </PageHeader>
      <PageContent>
        <div className="grid min-w-0 gap-4 lg:grid-cols-[18rem_1fr]">
          <BotList selectedId={selectedId} onSelect={setSelectedId} />
          {selected === undefined ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>选择一个机器人</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex min-w-0 flex-col gap-4">
              <Card>
                <CardContent className="flex flex-col gap-3">
                  <Conversation id={selected.id} />
                  <Composer botId={selected.id} botEnabled={selected.enabled} />
                </CardContent>
              </Card>
              <Routines botId={selected.id} otherBotIds={otherBotIds} />
              <ConfigSection botId={selected.id} configPath={selected.configPath} tools={selected.tools} />
            </div>
          )}
        </div>
      </PageContent>
    </Page>
  );
}
