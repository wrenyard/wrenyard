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

  const filterKey = (props.filter ?? '').trim().toLowerCase();
  const items: Routine[] = (routines.data?.routines ?? []).filter((item) =>
    item.botId === props.botId && (filterKey === '' ? true : item.prompt.toLowerCase().includes(filterKey)),
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
    if (prompt.trim().length === 0 || !Number.isFinite(minutes) || minutes < 1 || create.isPending) return;
    create.mutate(
      {
        botId: props.botId,
        prompt: prompt.trim(),
        intervalMinutes: minutes,
        name: name.trim() === '' ? undefined : name.trim(),
      },
      {
        onSuccess: () => {
          setPrompt('');
          setIntervalMinutes('5');
          setName('');
          setCreating(false);
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          例行任务（仅在本机运行）
          {props.botName !== undefined && props.botName !== '' && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">{props.botName}</span>
          )}
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
                      <Tooltip>
                        <TooltipTrigger render={<span className="block max-w-[16rem] truncate font-medium" />}>
                          {item.prompt}
                        </TooltipTrigger>
                        <TooltipContent>{item.prompt}</TooltipContent>
                      </Tooltip>
                      {item.name !== undefined && (
                        <span className="mt-1 block text-xs text-muted-foreground">{item.name}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {frequencyText(item.intervalMinutes)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={view.tone} label={view.label} />
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {item.nextRunAt === undefined ? NONE : <Timestamp value={item.nextRunAt} />}
                    </TableCell>
                    <TableCell className="max-w-[10rem] truncate text-xs">
                      {item.lastError === undefined ? NONE : <span className="text-destructive">{item.lastError}</span>}
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
        {creating ? (
          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <Textarea value={prompt} rows={2} placeholder="例行任务提示词" onChange={(event) => setPrompt(event.target.value)} />
            <div className="flex flex-wrap items-center gap-4">
              <Field className="flex items-center gap-2">
                <FieldLabel>名称（可选）</FieldLabel>
                <Input
                  value={name}
                  maxLength={64}
                  className="w-48"
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
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
              <Button size="sm" className="ml-auto" disabled={create.isPending} onClick={submit}>
                新建
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                取消
              </Button>
            </div>
            {create.isError && <span className="text-xs text-destructive">{String(create.error)}</span>}
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            新建例行任务
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
