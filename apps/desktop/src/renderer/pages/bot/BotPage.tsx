import { useState } from 'react';
import type { ReactNode } from 'react';
import { Page, PageContent, PageDescription, PageHeader, PageTitle } from '@/renderer/components/page';
import { QueryError } from '@/renderer/components/query-error';
import { StatusBadge } from '@/renderer/components/status-badge';
import type { StatusTone } from '@/renderer/components/status-badge';
import { Elapsed } from '@/renderer/components/elapsed';
import { Timestamp } from '@/renderer/components/timestamp';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import { Field, FieldLabel } from '@/renderer/components/ui/field';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { ScrollArea } from '@/renderer/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { Switch } from '@/renderer/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/renderer/components/ui/table';
import { Textarea } from '@/renderer/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { useConfirm } from '@/renderer/hooks/use-confirm';
import { executeCommand } from '@/renderer/lib/commands';
import { toast } from '@/renderer/lib/notify';
import { useRemoteConnection } from '@/renderer/lib/desktop';
import { formatElapsedMs } from '@/renderer/lib/format';
import type {
  BotAcceptanceCheck,
  BotComponentId,
  BotComponentState,
  BotItemAction,
  BotItemRecord,
  BotItemState,
  BotLogRecord,
  BotMode,
  BotState,
} from '@/shell-contract';
import {
  useBotConfigValidateMutation,
  useBotControlMutation,
  useBotCreateMutation,
  useBotHealthQuery,
  useBotItemActionMutation,
  useBotItemsQuery,
  useBotLogQuery,
  useBotsQuery,
  useBotTickMutation,
} from './queries.js';

/** One-line placeholder for an absent value. */
const NONE = '—';

const PAGE_TITLE = '机器人';

/** Chinese label of every pipeline state. */
const ITEM_STATE_LABELS: Record<BotItemState, string> = {
  discovered: '已发现',
  verifying: '核实中',
  verified: '已核实',
  dispatched: '已派发',
  in_progress: '进行中',
  ready: '待验收',
  accepting: '验收中',
  accepted: '已通过',
  rejected: '已退回',
  merging: '合入中',
  merged: '已合入',
  completing: '收尾中',
  completed: '已完成',
  dismissed: '已驳回',
  parked: '待决定',
  failed: '失败',
  withdrawn: '已撤回',
};

const ITEM_STATE_TONES: Record<BotItemState, StatusTone> = {
  discovered: 'muted',
  verifying: 'running',
  verified: 'muted',
  dispatched: 'muted',
  in_progress: 'running',
  ready: 'warning',
  accepting: 'running',
  accepted: 'success',
  rejected: 'danger',
  merging: 'running',
  merged: 'success',
  completing: 'running',
  completed: 'success',
  dismissed: 'muted',
  parked: 'warning',
  failed: 'danger',
  withdrawn: 'muted',
};

/** States whose item is finished and can only be cleaned up. */
const TERMINAL_STATES: ReadonlySet<BotItemState> = new Set([
  'completed',
  'dismissed',
  'withdrawn',
  'failed',
]);

const BOT_STATE_VIEW: Record<BotState, { label: string; tone: StatusTone }> = {
  running: { label: '运行中', tone: 'running' },
  paused: { label: '已暂停', tone: 'warning' },
  stopped: { label: '已停止', tone: 'muted' },
};

const MODE_LABELS: Record<BotMode, string> = { dryRun: '试运行', live: '正式' };

const COMPONENT_NAMES: Record<BotComponentId, string> = { browser: 'agent-browser', desktop: 'Cua Driver' };

const COMPONENT_STATE_LABELS: Record<BotComponentState, string> = {
  'not-installed': '未安装',
  installing: '安装中',
  'needs-authorization': '待授权',
  ready: '就绪',
  failed: '失败',
  unsupported: '不支持',
  disabled: '已停用',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Chinese text for the error strings the daemon stores on an item. `session
 * stalled` and `task run missing` are reasons, the rest are codes.
 */
const ERROR_LABELS: Record<string, string> = {
  session_blocked: '会话请求决定',
  'session stalled': '会话停滞',
  'task run missing': '任务运行丢失',
  rebase_conflict: '变基冲突',
  bot_owned: '归机器人所有',
};

/** Longest raw error shown before it is elided; the tooltip keeps it whole. */
const ERROR_TEXT_LIMIT = 80;

/** Codes of the routine housekeeping rows the default log view hides. */
const ROUTINE_LOG_CODES: ReadonlySet<string> = new Set([
  'poll.ok',
  'poll.unchanged',
  'tick.skipped',
  'notify.deferred',
]);

/** Routine rows are debug-level, or carry one of {@link ROUTINE_LOG_CODES}. */
function isRoutineLogEntry(entry: BotLogRecord): boolean {
  if (entry.level === 'debug') return true;
  return entry.code !== undefined && ROUTINE_LOG_CODES.has(entry.code);
}

/** Known error text in Chinese, else the raw text truncated to {@link ERROR_TEXT_LIMIT}. */
function describeError(error: string): string {
  const known = ERROR_LABELS[error.trim()];
  if (known !== undefined) return known;
  return error.length > ERROR_TEXT_LIMIT ? `${error.slice(0, ERROR_TEXT_LIMIT)}…` : error;
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/** `✓ n ✗ n ? n` over the required checks. */
function acceptanceSummary(checks: BotAcceptanceCheck[]): string {
  const verified = checks.filter((check) => check.status === 'verified').length;
  const failed = checks.filter((check) => check.status === 'failed').length;
  const unknown = checks.filter((check) => check.status === 'not_verified').length;
  return `✓ ${verified} ✗ ${failed} ? ${unknown}`;
}

function checkMark(status: BotAcceptanceCheck['status']): string {
  if (status === 'verified') return '✓';
  if (status === 'failed') return '✗';
  return '?';
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-sm tabular-nums">{children}</span>
    </div>
  );
}

/** The 机器人 page: one bot's status, pipeline, decisions and live log. */
export function BotPage() {
  const bots = useBotsQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = bots.data?.bots ?? [];
  const current = list.find((bot) => bot.id === selectedId) ?? list[0] ?? null;
  const botId = current?.id ?? null;

  const items = useBotItemsQuery(botId);
  const health = useBotHealthQuery(botId);
  const log = useBotLogQuery(botId);
  const control = useBotControlMutation();
  const tick = useBotTickMutation();
  const create = useBotCreateMutation();
  const validate = useBotConfigValidateMutation();
  const itemAction = useBotItemActionMutation();
  const confirm = useConfirm();
  const connection = useRemoteConnection();

  const [name, setName] = useState('');
  const [configPath, setConfigPath] = useState('');
  const [mode, setMode] = useState<BotMode>('dryRun');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [showRoutineLog, setShowRoutineLog] = useState(false);

  const pipeline = items.data?.items ?? [];
  const decisions = pipeline.filter(
    (item) => item.state === 'parked' || TERMINAL_STATES.has(item.state),
  );

  const routineLogCount = log.entries.filter(isRoutineLogEntry).length;
  const hiddenLogCount = showRoutineLog ? 0 : routineLogCount;
  const visibleLog = (showRoutineLog ? log.entries : log.entries.filter((entry) => !isRoutineLogEntry(entry)))
    .slice()
    .reverse();

  const connectionLine = connection.state === 'local'
    ? '本地守护进程'
    : connection.state === 'remote'
      ? `远程 · ${connection.host?.displayName ?? NONE}`
      : connection.state === 'connecting'
        ? '正在切换远程连接…'
        : '远程连接已断开';

  const runItemAction = (item: BotItemRecord, action: BotItemAction, answer?: string): void => {
    void itemAction
      .mutateAsync({
        botId: item.botId,
        itemId: item.id,
        action,
        ...(answer === undefined ? {} : { answer }),
      })
      .catch((error: unknown) => {
        toast(`操作失败：${errorMessage(error)}`, { level: 'error' });
      });
  };

  const requestCleanup = (item: BotItemRecord): void => {
    void confirm({
      title: '清理此条目？',
      description: '只删除条目记录；会话与工作树不会被删除。',
      confirmLabel: '清理',
      destructive: true,
    }).then((confirmed) => {
      if (confirmed) runItemAction(item, 'cleanup');
    });
  };

  const requestCreate = (): void => {
    const trimmedName = name.trim();
    const trimmedPath = configPath.trim();
    void (async () => {
      try {
        const validation = await validate.mutateAsync(trimmedPath);
        if (!validation.valid) return;
        const created = await create.mutateAsync({ name: trimmedName, configPath: trimmedPath, mode });
        setSelectedId(created.bot.id);
        setName('');
        setConfigPath('');
        setMode('dryRun');
        toast(`已创建机器人「${created.bot.name}」`);
      } catch (error) {
        toast(`创建失败：${errorMessage(error)}`, { level: 'error' });
      }
    })();
  };

  const createForm = (
    <div className="flex max-w-md flex-col gap-3">
      <Field>
        <FieldLabel>名称</FieldLabel>
        <Input
          value={name}
          placeholder="例如 dev-bot"
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel>配置文件路径</FieldLabel>
        <Input
          value={configPath}
          placeholder={'<configHome>/bots/example.json'}
          onChange={(event) => setConfigPath(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel>模式</FieldLabel>
        <Select
          value={mode}
          onValueChange={(value) => setMode(String(value) === 'live' ? 'live' : 'dryRun')}
        >
          <SelectTrigger className="w-full" aria-label="模式">
            <SelectValue>{(value) => MODE_LABELS[String(value) === 'live' ? 'live' : 'dryRun']}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dryRun">试运行</SelectItem>
            <SelectItem value="live">正式</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {validate.data !== undefined && !validate.data.valid ? (
        <p className="text-sm text-destructive">{validate.data.error ?? '配置文件校验未通过'}</p>
      ) : null}
      {validate.data?.valid === true ? (
        <p className="text-sm text-muted-foreground">{`配置文件有效：${validate.data.name ?? ''}`}</p>
      ) : null}
      <div>
        <Button
          size="sm"
          disabled={name.trim() === '' || configPath.trim() === '' || validate.isPending || create.isPending}
          onClick={requestCreate}
        >
          创建
        </Button>
      </div>
    </div>
  );

  return (
    <Page data-page="bot">
      <PageHeader>
        <PageTitle>{PAGE_TITLE}</PageTitle>
        <PageDescription>
          {list.length === 0 ? '尚未配置机器人' : `共 ${list.length} 个机器人`}
        </PageDescription>
      </PageHeader>
      <PageContent>
        {bots.isError ? (
          <QueryError query={bots} title={PAGE_TITLE} />
        ) : bots.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : current === null ? (
          <Card className="min-w-0">
            <CardContent>
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>暂无机器人</EmptyTitle>
                  <EmptyDescription>
                    机器人是常驻的总调度官：它从你本机的收件箱取回待办，逐件派发会话与工作树，实机验收后逐个交付。
                    配置文件放在配置目录的 bots/ 下，其中的收件箱与通知渠道由你自己配置。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
              <div className="mt-4">{createForm}</div>
            </CardContent>
          </Card>
        ) : (
          <div className="flex min-w-0 flex-col gap-4">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>状态</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  {list.length > 1 ? (
                    <Select value={current.id} onValueChange={(value) => setSelectedId(String(value))}>
                      <SelectTrigger aria-label="选择机器人">
                        <SelectValue>
                          {(value) => list.find((bot) => bot.id === String(value))?.name ?? String(value)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {list.map((bot) => (
                          <SelectItem key={bot.id} value={bot.id}>{bot.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="font-medium">{current.name}</span>
                  )}
                  <StatusBadge
                    tone={BOT_STATE_VIEW[current.state].tone}
                    label={BOT_STATE_VIEW[current.state].label}
                  />
                  {current.mode === 'dryRun' ? <StatusBadge tone="warning" label="试运行" /> : null}
                  <div className="ml-auto flex items-center gap-1">
                    {current.state === 'running' ? (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={control.isPending}
                        onClick={() => control.mutate({ botId: current.id, action: 'pause' })}
                      >
                        暂停
                      </Button>
                    ) : null}
                    {current.state === 'paused' ? (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={control.isPending}
                        onClick={() => control.mutate({ botId: current.id, action: 'resume' })}
                      >
                        继续
                      </Button>
                    ) : null}
                    {current.state === 'stopped' ? (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={control.isPending}
                        onClick={() => control.mutate({ botId: current.id, action: 'start' })}
                      >
                        启动
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={control.isPending}
                        onClick={() => control.mutate({ botId: current.id, action: 'stop' })}
                      >
                        停止
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={tick.isPending || current.state === 'stopped'}
                      onClick={() => tick.mutate(current.id)}
                    >
                      立即运行
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    上次 tick：
                    {current.lastTickAt === undefined ? NONE : <Timestamp value={current.lastTickAt} precision="second" />}
                  </span>
                  <span>
                    下次轮询：
                    {current.nextPollAt === undefined ? NONE : <Timestamp value={current.nextPollAt} />}
                  </span>
                  <span>{connectionLine}</span>
                </div>
                {health.data ? (
                  <p className="text-xs text-muted-foreground">
                    {`运行于 ${health.data.host.hostname} · ${health.data.host.platform}/${health.data.host.arch} · Wrenyard ${health.data.host.daemonVersion ?? NONE} (${health.data.host.mode === 'installed' ? '安装版' : '源码'})`}
                  </p>
                ) : null}
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>健康</CardTitle>
              </CardHeader>
              <CardContent>
                {health.isError ? (
                  <QueryError query={health} title="健康" />
                ) : health.data ? (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-3 @3xl/main:grid-cols-4">
                      <Stat label="运行时长"><Elapsed start={health.data.uptimeSince} /></Stat>
                      <Stat label="tick 次数">{health.data.ticks}</Stat>
                      <Stat label="tick 延迟（当前/最大 ms）">
                        {`${health.data.tickLagMs.last} / ${health.data.tickLagMs.max}`}
                      </Stat>
                      <Stat label="24h 失败步骤">{health.data.stepsFailed24h}</Stat>
                      <Stat label="24h 适配器错误">{health.data.adapterErrors24h}</Stat>
                      <Stat label="24h 上报提醒">{health.data.escalations24h}</Stat>
                      <Stat label="负载">
                        {health.data.load === undefined ? NONE : (
                          <span className="inline-flex min-w-0 items-center gap-1">
                            <span className="truncate tabular-nums">
                              {`${health.data.load.activeExecutions}/${health.data.load.maxExecutions} 执行中 · ${health.data.load.queuedExecutions} 排队`}
                            </span>
                            {health.data.load.oldestQueuedMs === undefined ? null : (
                              <span className="truncate text-muted-foreground">
                                {`（排队最久 ${formatElapsedMs(health.data.load.oldestQueuedMs)}）`}
                              </span>
                            )}
                            {health.data.load.backedOff ? <StatusBadge tone="warning" label="已退避" /> : null}
                          </span>
                        )}
                      </Stat>
                      <Stat label="组件">
                        {health.data.components.length === 0
                          ? NONE
                          : health.data.components
                            .map((component) => `${COMPONENT_NAMES[component.id]} ${COMPONENT_STATE_LABELS[component.state]}`)
                            .join(' · ')}
                      </Stat>
                      <Stat label="最近错误">
                        {health.data.lastError === undefined ? (
                          NONE
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <Timestamp value={health.data.lastError.at} precision="second" />
                            <span>{`· ${health.data.lastError.code}`}</span>
                          </span>
                        )}
                      </Stat>
                    </div>
                    {health.data.lastError === undefined ? null : (
                      <p className="text-xs text-muted-foreground">{health.data.lastError.message}</p>
                    )}
                  </div>
                ) : (
                  <Skeleton className="h-16 w-full" />
                )}
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>流水线</CardTitle>
              </CardHeader>
              <CardContent>
                {items.isError ? (
                  <QueryError query={items} title="流水线" />
                ) : items.isPending ? (
                  <Skeleton className="h-16 w-full" />
                ) : pipeline.length === 0 ? (
                  <p className="text-sm text-muted-foreground">暂无条目。</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>标题</TableHead>
                        <TableHead>项目</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>类型</TableHead>
                        <TableHead>更新</TableHead>
                        <TableHead>会话</TableHead>
                        <TableHead>工作树</TableHead>
                        <TableHead>合入</TableHead>
                        <TableHead>验收</TableHead>
                        <TableHead>错误</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pipeline.map((item) => {
                        const checks = item.acceptance ?? [];
                        return (
                          <TableRow key={item.id}>
                            <TableCell>
                              <Tooltip>
                                <TooltipTrigger render={<span className="block max-w-[20rem] truncate font-medium" />}>
                                  {item.title ?? item.sourceId}
                                </TooltipTrigger>
                                <TooltipContent>{item.title ?? item.sourceId}</TooltipContent>
                              </Tooltip>
                            </TableCell>
                            <TableCell className="text-muted-foreground">{item.project ?? NONE}</TableCell>
                            <TableCell>
                              <StatusBadge
                                tone={ITEM_STATE_TONES[item.state]}
                                label={ITEM_STATE_LABELS[item.state]}
                              />
                            </TableCell>
                            <TableCell className="text-muted-foreground">{item.class ?? NONE}</TableCell>
                            <TableCell className="text-muted-foreground tabular-nums">
                              <Timestamp value={item.updatedAt} precision="second" />
                            </TableCell>
                            <TableCell>
                              {item.sessionId === undefined ? NONE : (
                                <Button
                                  variant="link"
                                  size="xs"
                                  onClick={() => { executeCommand('session.open', item.sessionId); }}
                                >
                                  {shortSha(item.sessionId)}
                                </Button>
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {item.worktreeId === undefined ? NONE : (
                                <Tooltip>
                                  <TooltipTrigger render={<span className="block max-w-[10rem] truncate" />}>
                                    {item.worktreeId}
                                  </TooltipTrigger>
                                  <TooltipContent>{item.worktreeId}</TooltipContent>
                                </Tooltip>
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {item.mergedSha === undefined ? NONE : shortSha(item.mergedSha)}
                            </TableCell>
                            <TableCell className="text-muted-foreground tabular-nums">
                              {checks.length === 0 ? NONE : (
                                <Tooltip>
                                  <TooltipTrigger render={<span className="tabular-nums" />}>
                                    {acceptanceSummary(checks)}
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <div className="flex flex-col gap-0.5">
                                      {checks.map((check, index) => (
                                        <span key={`${check.claim}-${index}`}>
                                          {`${checkMark(check.status)} ${check.claim}`}
                                          {check.evidence !== undefined && check.evidence.length > 0
                                            ? ` — ${check.evidence.join(', ')}`
                                            : ''}
                                        </span>
                                      ))}
                                    </div>
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {item.error === undefined ? NONE : (
                                <Tooltip>
                                  <TooltipTrigger render={<span className="block max-w-[14rem] truncate" />}>
                                    {describeError(item.error)}
                                  </TooltipTrigger>
                                  <TooltipContent>{item.error}</TooltipContent>
                                </Tooltip>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>待决定</CardTitle>
              </CardHeader>
              <CardContent>
                {decisions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">暂无待决定事项。</p>
                ) : (
                  <div className="flex flex-col gap-4">
                    {decisions.map((item) => (
                      <div key={item.id} className="flex flex-col gap-2 border-b pb-4 last:border-b-0 last:pb-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{item.title ?? item.sourceId}</span>
                          <StatusBadge tone={ITEM_STATE_TONES[item.state]} label={ITEM_STATE_LABELS[item.state]} />
                        </div>
                        {item.question === undefined ? null : (
                          <p className="text-sm text-muted-foreground">{item.question}</p>
                        )}
                        {item.state === 'parked' ? (
                          <div className="flex flex-col gap-2">
                            <Textarea
                              value={answers[item.id] ?? ''}
                              placeholder="回答这个决定"
                              onChange={(event) => setAnswers((previous) => ({ ...previous, [item.id]: event.target.value }))}
                            />
                            <div className="flex items-center gap-1">
                              <Button
                                variant="outline"
                                size="xs"
                                disabled={itemAction.isPending || (answers[item.id] ?? '').trim() === ''}
                                onClick={() => runItemAction(item, 'answer', (answers[item.id] ?? '').trim())}
                              >
                                回答
                              </Button>
                              <Button
                                variant="ghost"
                                size="xs"
                                disabled={itemAction.isPending}
                                onClick={() => runItemAction(item, 'dismiss')}
                              >
                                驳回
                              </Button>
                            </div>
                          </div>
                        ) : null}
                        <div className="flex items-center gap-1">
                          {item.state === 'failed' ? (
                            <Button
                              variant="outline"
                              size="xs"
                              disabled={itemAction.isPending}
                              onClick={() => runItemAction(item, 'retry')}
                            >
                              重试
                            </Button>
                          ) : null}
                          {TERMINAL_STATES.has(item.state) ? (
                            <Button
                              variant="ghost"
                              size="xs"
                              className="text-destructive"
                              disabled={itemAction.isPending}
                              onClick={() => requestCleanup(item)}
                            >
                              清理
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>日志</CardTitle>
                <CardAction>
                  <div className="flex items-center gap-2">
                    {hiddenLogCount > 0 ? (
                      <span className="text-xs text-muted-foreground">{`已隐藏 ${hiddenLogCount} 条例行日志`}</span>
                    ) : null}
                    <Label htmlFor="bot-show-routine-log">显示例行日志</Label>
                    <Switch
                      id="bot-show-routine-log"
                      checked={showRoutineLog}
                      onCheckedChange={(checked) => setShowRoutineLog(checked)}
                    />
                  </div>
                </CardAction>
              </CardHeader>
              <CardContent>
                {log.query.isError ? (
                  <QueryError query={log.query} title="日志" />
                ) : log.entries.length === 0 ? (
                  <p className="text-sm text-muted-foreground">暂无日志。</p>
                ) : visibleLog.length === 0 ? (
                  <p className="text-sm text-muted-foreground">仅剩例行日志，打开「显示例行日志」可查看。</p>
                ) : (
                  <ScrollArea className="h-[480px]">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>时间</TableHead>
                          <TableHead>级别</TableHead>
                          <TableHead>代码</TableHead>
                          <TableHead>消息</TableHead>
                          <TableHead>条目</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {visibleLog.map((entry) => (
                          <TableRow key={entry.seq}>
                            <TableCell className="text-muted-foreground tabular-nums">
                              <Timestamp value={entry.at} precision="second" />
                            </TableCell>
                            <TableCell className="text-muted-foreground">{entry.level}</TableCell>
                            <TableCell className="text-muted-foreground">{entry.code ?? NONE}</TableCell>
                            <TableCell>{entry.message}</TableCell>
                            <TableCell className="text-muted-foreground">
                              {entry.itemId === undefined ? NONE : shortSha(entry.itemId)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </PageContent>
    </Page>
  );
}
