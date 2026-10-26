import { useState } from 'react';
import { QueryError } from '@/renderer/components/query-error';
import { StatusBadge } from '@/renderer/components/status-badge';
import { Timestamp } from '@/renderer/components/timestamp';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Field, FieldLabel } from '@/renderer/components/ui/field';
import { Input } from '@/renderer/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/renderer/components/ui/table';
import { Textarea } from '@/renderer/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { useConfirm } from '@/renderer/hooks/use-confirm';
import { errorMessage } from '../settings/model/settings.js';
import type { Routine } from '@/shell-contract';
import {
  ROUTINE_STATE_VIEW,
  frequencyText,
  useCreateRoutineMutation,
  useDeleteRoutineMutation,
  useRunRoutineMutation,
  useRoutinesQuery,
  useUpdateRoutineMutation,
} from '../agents/queries.js';

/** One-line placeholder for an absent time. */
const NONE = '—';

/** Routines section: one bot's routine table with row actions and a create form. */
export function RoutinesSection(props: { botId: string; botName?: string; filter?: string }) {
  const routines = useRoutinesQuery();
  const update = useUpdateRoutineMutation();
  const run = useRunRoutineMutation();
  const remove = useDeleteRoutineMutation();
  const create = useCreateRoutineMutation();
  const confirm = useConfirm();

  const [creating, setCreating] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [interval, setIntervalMinutes] = useState('5');
  const [trigger, setTrigger] = useState<'interval' | 'todo'>('interval');
  const [matchRules, setMatchRules] = useState('comment');
  const [editingId, setEditingId] = useState<string | undefined>();

  const filterKey = (props.filter ?? '').trim().toLowerCase();
  const items: Routine[] = (routines.data?.routines ?? []).filter((item) =>
    item.botId === props.botId && (filterKey === '' ? true : item.prompt.toLowerCase().includes(filterKey) || (item.name ?? '').trim().toLowerCase().includes(filterKey)),
  );

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
    const rules = matchRules.split('\n').map(rule => rule.trim()).filter(Boolean);
    if (prompt.trim().length === 0 || (trigger === 'interval' && (!Number.isFinite(minutes) || minutes < 1))
      || (trigger === 'todo' && rules.length === 0) || create.isPending || update.isPending) return;
    const fields = {
      prompt: prompt.trim(),
      name: name.trim() === '' ? undefined : name.trim(),
      ...(trigger === 'interval' ? { intervalMinutes: minutes } : { on: 'todo' as const, match: rules }),
    };
    if (editingId !== undefined) {
      update.mutate({ id: editingId, ...fields }, { onSuccess: () => { setEditingId(undefined); setCreating(false); } });
    } else create.mutate(
      {
        botId: props.botId,
        ...fields,
      },
      {
        onSuccess: () => {
          setPrompt('');
          setIntervalMinutes('5');
          setName('');
          setTrigger('interval');
          setMatchRules('comment');
          setCreating(false);
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {props.botName || '例行任务'}
        </CardTitle>
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
                      {item.name !== undefined && item.name !== '' ? (
                        <>
                          <span className="block font-medium">{item.name}</span>
                          <Tooltip>
                            <TooltipTrigger render={<span className="mt-1 block max-w-[16rem] truncate text-xs text-muted-foreground" />}>
                              {item.prompt}
                            </TooltipTrigger>
                            <TooltipContent>{item.prompt}</TooltipContent>
                          </Tooltip>
                        </>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger render={<span className="block max-w-[16rem] truncate font-medium" />}>
                            {item.prompt}
                          </TooltipTrigger>
                          <TooltipContent>{item.prompt}</TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {frequencyText(item.intervalMinutes, item.on, item.match)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={view.tone} label={view.label} />
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {item.nextRunAt === undefined ? NONE : <Timestamp value={item.nextRunAt} />}
                    </TableCell>
                    <TableCell className="max-w-[10rem] truncate text-xs">
                      {item.lastError === undefined ? NONE : (
                        <Tooltip>
                          <TooltipTrigger render={<span className="block max-w-[10rem] truncate text-destructive" />}>
                            {item.lastError}
                          </TooltipTrigger>
                          <TooltipContent>{item.lastError}</TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex shrink-0 items-center justify-end gap-1">
                        <Button variant="ghost" size="xs" onClick={() => {
                          setEditingId(item.id); setPrompt(item.prompt); setName(item.name ?? '');
                          setTrigger(item.on === 'todo' ? 'todo' : 'interval');
                          setIntervalMinutes(String(item.intervalMinutes ?? 5));
                          setMatchRules((item.match ?? []).join('\n')); setCreating(true);
                        }}>编辑</Button>
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
                        {item.intervalMinutes !== undefined && <Button variant="outline" size="xs" disabled={run.isPending} onClick={() => run.mutate(item.id)}>
                          立即运行
                        </Button>}
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
        {creating ? (
          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <Textarea value={prompt} rows={2} placeholder="例行任务提示词" onChange={(event) => setPrompt(event.target.value)} />
            <div className="flex flex-wrap items-center gap-4">
              <Field className="flex items-center gap-2">
                <FieldLabel>触发方式</FieldLabel>
                <select className="h-9 rounded-md border bg-background px-2 text-sm" value={trigger} onChange={event => setTrigger(event.target.value as 'interval' | 'todo')}>
                  <option value="interval">定时间隔</option><option value="todo">Todo 事件</option>
                </select>
              </Field>
              <Field className="flex items-center gap-2">
                <FieldLabel>名称（可选）</FieldLabel>
                <Input
                  value={name}
                  maxLength={64}
                  className="w-48"
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              {trigger === 'interval' ? <Field className="flex items-center gap-2">
                <FieldLabel>间隔（分钟）</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  value={interval}
                  className="w-24"
                  onChange={(event) => setIntervalMinutes(event.target.value)}
                />
              </Field> : <Field className="flex min-w-64 flex-1 items-center gap-2">
                <FieldLabel>匹配规则（每行一条）</FieldLabel>
                <Textarea value={matchRules} rows={3} placeholder={'+delivered\nstatus:done\ncomment'} onChange={event => setMatchRules(event.target.value)} />
              </Field>}
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => { setCreating(false); setEditingId(undefined); }}>
                取消
              </Button>
              <Button size="sm" disabled={create.isPending} onClick={submit}>
                {editingId === undefined ? '新建' : '保存'}
              </Button>
            </div>
            {(create.isError || update.isError) && <span className="text-xs text-destructive">{errorMessage(create.error ?? update.error)}</span>}
          </div>
        ) : (
          <Button variant="outline" size="sm" className="self-start" onClick={() => setCreating(true)}>
            新建例行任务
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
