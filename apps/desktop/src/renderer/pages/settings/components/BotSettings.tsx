import { useEffect, useMemo, useState } from 'react';
import { QueryError } from '@/renderer/components/query-error';
import { StatusBadge } from '@/renderer/components/status-badge';
import { Timestamp } from '@/renderer/components/timestamp';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Checkbox } from '@/renderer/components/ui/checkbox';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import { Field, FieldLabel } from '@/renderer/components/ui/field';
import { Input } from '@/renderer/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/renderer/components/ui/table';
import { Textarea } from '@/renderer/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { useConfirm } from '@/renderer/hooks/use-confirm';
import type { AgentBot, Routine } from '@/shell-contract';
import {
  ROUTINE_STATE_VIEW,
  deliverText,
  frequencyText,
  useAgentConfigQuery,
  useAgentMemoryQuery,
  useAgentsQuery,
  useCreateRoutineMutation,
  useDeleteRoutineMutation,
  useRunRoutineMutation,
  useRoutinesQuery,
  useUpdateRoutineMutation,
} from '../../agents/queries.js';

/** One-line placeholder for an absent time. */
const NONE = '—';

/** The five tool switches a bot definition may declare. */
const TOOL_IDS = ['session', 'todo', 'message', 'memory', 'workspace'] as const;

/** The icon of one bot: its identity icon, else the first character of its name. */
function botIcon(bot: AgentBot): string {
  const icon = bot.icon?.trim();
  if (icon !== undefined && icon !== '') return icon;
  return [...bot.name.trim()][0] ?? bot.id.slice(0, 1);
}

/** One picker line: icon, name, the 主 marker and where the definition lives. */
function botOptionLabel(bot: AgentBot): string {
  const parts = [botIcon(bot), bot.name];
  if (bot.primary) parts.push('主');
  parts.push(bot.location === 'workspace' ? 'Workspace' : '本机');
  if (!bot.enabled) parts.push('已停用');
  return parts.join(' · ');
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
        <CardTitle>例行任务（仅在本机运行）</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {routines.isError && <QueryError query={routines} title="例行任务" />}
        {items.length === 0 ? (
          routines.isError ? null : (
            <p className="text-sm text-muted-foreground">
              {routines.isPending ? '正在加载例行任务…' : '暂无例行任务。'}
            </p>
          )
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

/**
 * Config section: the bot directory, the five tool chips, and the read-only
 * `bot.json`, `identity.md` and memory listing of the definition.
 */
function ConfigSection(props: { botId: string; tools: readonly string[] }) {
  const config = useAgentConfigQuery(props.botId);
  const memory = useAgentMemoryQuery(props.botId);
  const files = memory.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>配置</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="text-xs text-muted-foreground">{config.data?.bot.directory ?? props.botId}</div>
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
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">bot.json</span>
          <pre className="max-h-48 overflow-auto rounded-lg bg-muted p-3 text-xs">
            {config.isError ? '配置读取失败。' : config.data?.config ?? '…'}
          </pre>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">identity.md</span>
          <pre className="max-h-48 overflow-auto rounded-lg bg-muted p-3 text-xs">
            {config.isError ? '身份读取失败。' : config.data?.identity ?? '…'}
          </pre>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">记忆</span>
          {memory.isError ? (
            <span className="text-xs text-destructive">{String(memory.error)}</span>
          ) : files.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              {memory.isPending ? '正在加载记忆…' : '暂无记忆文件。'}
            </span>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>文件</TableHead>
                  <TableHead>大小</TableHead>
                  <TableHead>更新</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.map((file) => (
                  <TableRow key={file.name}>
                    <TableCell className="font-medium">{file.name}</TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">{file.size}</TableCell>
                    <TableCell className="text-muted-foreground">
                      <Timestamp value={file.updatedAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The Settings 机器人 page: the bot picker, the selected bot's routines and its
 * read-only config. These controls left the group chat page so the 机器人 page
 * stays a conversation; the daemon still owns config and routine state, and
 * nothing here adds storage or a config format.
 */
export function BotSettings() {
  const agents = useAgentsQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const bots = agents.data?.bots ?? [];

  // Keep a valid selection as the polled list changes.
  useEffect(() => {
    const list = agents.data?.bots ?? [];
    if (list.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !list.some((bot) => bot.id === selectedId)) setSelectedId(list[0]!.id);
  }, [agents.data, selectedId]);

  const selected = useMemo(
    () => bots.find((bot) => bot.id === selectedId),
    [bots, selectedId],
  );
  const otherBotIds = useMemo(
    () => bots.filter((bot) => bot.id !== selectedId).map((bot) => bot.id),
    [bots, selectedId],
  );

  if (agents.isError) return <QueryError query={agents} title="机器人" />;
  if (agents.isPending) return <Skeleton className="h-24 w-full" />;
  if (bots.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>没有机器人</EmptyTitle>
          <EmptyDescription>
            在机器人页面用引导向导创建一个；也可以自己在工作区的
            {' '}
            <code>bots/&lt;id&gt;/</code>
            {' '}
            目录（多设备同步）或配置目录的
            {' '}
            <code>bots/&lt;id&gt;/</code>
            {' '}
            目录（仅本机）下放 bot.json、identity.md 和 memory/。
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">机器人</span>
        <Select value={selectedId ?? bots[0]?.id ?? ''} onValueChange={(value) => setSelectedId(String(value))}>
          <SelectTrigger className="w-64" aria-label="选择机器人">
            <SelectValue>
              {(value) => {
                const bot = bots.find((entry) => entry.id === value);
                return bot === undefined ? String(value) : botOptionLabel(bot);
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {bots.map((bot) => (
              <SelectItem key={bot.id} value={bot.id}>
                {botOptionLabel(bot)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {selected !== undefined && (
        <>
          <Routines botId={selected.id} otherBotIds={otherBotIds} />
          <ConfigSection botId={selected.id} tools={selected.tools} />
        </>
      )}
    </div>
  );
}
