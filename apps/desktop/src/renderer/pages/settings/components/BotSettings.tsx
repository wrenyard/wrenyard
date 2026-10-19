import { useEffect, useMemo, useState } from 'react';
import { QueryError } from '@/renderer/components/query-error';
import { Timestamp } from '@/renderer/components/timestamp';
import { Card, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/renderer/components/ui/table';
import type { AgentBot } from '@/shell-contract';
import {
  useAgentConfigQuery,
  useAgentMemoryQuery,
  useAgentsQuery,
} from '../../agents/queries.js';

/** The tool switches a bot definition may declare. */
const TOOL_IDS = ['session', 'todo', 'message', 'memory', 'routine', 'workspace'] as const;

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
 * The Settings 机器人 page: the bot picker and the selected bot's read-only
 * config. Routines left this page for the dedicated 自动化 page, and the daemon
 * still owns config and routine state, so nothing here adds storage or a config
 * format.
 */
export function BotSettings(props: { focusBotId?: string | null }) {
  const agents = useAgentsQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const bots = agents.data?.bots ?? [];

  // A deep link naming one bot selects it once the loaded list contains it.
  useEffect(() => {
    const focus = props.focusBotId;
    if (focus === undefined || focus === null) return;
    if (bots.some((bot) => bot.id === focus)) setSelectedId(focus);
  }, [props.focusBotId, bots]);

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
        <ConfigSection botId={selected.id} tools={selected.tools} />
      )}
    </div>
  );
}
