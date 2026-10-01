import { BrandIcon } from '@/renderer/components/brand-icon';
import { Elapsed } from '@/renderer/components/elapsed';
import { StatusBadge } from '@/renderer/components/status-badge';
import { Timestamp } from '@/renderer/components/timestamp';
import { Card, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/renderer/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { formatElapsedMs, formatTokenCount } from '@/renderer/lib/format';
import { statusView } from '@/renderer/lib/task-status';
import { TASK_RUNS_EMPTY, TASK_RUNS_TITLE } from '../model/describe.js';
import type { TaskRunRow } from '../model/stats.js';

/** The last fifty runs with status, model brands and terminal-only telemetry. */
export function TaskRunsTable({ rows }: { rows: TaskRunRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{TASK_RUNS_TITLE}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>状态</TableHead>
              <TableHead>任务</TableHead>
              <TableHead>模型</TableHead>
              <TableHead className="text-right">↑输入 / ↓输出</TableHead>
              <TableHead className="text-right">速度</TableHead>
              <TableHead className="text-right">耗时</TableHead>
              <TableHead>完成时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">{TASK_RUNS_EMPTY}</TableCell>
              </TableRow>
            ) : rows.map((row) => (
              <TableRow key={row.taskRunId}>
                <TableCell><StatusCell status={row.status} /></TableCell>
                <TableCell>{row.label}</TableCell>
                <TableCell><ModelCell row={row} /></TableCell>
                <TableCell className="text-right tabular-nums">
                  {`↑${row.inputTokens === undefined ? '-' : formatTokenCount(row.inputTokens)} / ↓${row.outputTokens === undefined ? '-' : formatTokenCount(row.outputTokens)}`}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.tps === undefined ? '-' : `${row.tps.toFixed(2)} TPS`}
                </TableCell>
                <TableCell className="text-right tabular-nums"><DurationCell row={row} /></TableCell>
                <TableCell>{row.finishedAt === undefined ? '-' : <Timestamp value={row.finishedAt} />}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Icon-only shared status badge; the label is the tooltip and accessible name. */
function StatusCell({ status }: { status: TaskRunRow['status'] }) {
  const view = statusView(status);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" aria-label={view.label} />}>
        <StatusBadge tone={view.tone} label="" />
      </TooltipTrigger>
      <TooltipContent>{view.label}</TooltipContent>
    </Tooltip>
  );
}

/** Paired provider and model display names; a missing half renders the whole cell as a dash. */
function ModelCell({ row }: { row: TaskRunRow }) {
  if (row.providerName === undefined || row.modelName === undefined) return <span>-</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1">
        {row.providerBrand ? <BrandIcon brand={row.providerBrand} size={16} /> : null}
        <span>{row.providerName}</span>
      </span>
      <span className="text-muted-foreground">·</span>
      <span className="inline-flex items-center gap-1">
        {row.modelBrand ? <BrandIcon brand={row.modelBrand} size={16} /> : null}
        <span>{row.modelName}</span>
      </span>
    </span>
  );
}

/** Terminal runs render a fixed duration; a running run ticks through `Elapsed`. */
function DurationCell({ row }: { row: TaskRunRow }) {
  if (row.durationMs !== undefined) return <span>{formatElapsedMs(row.durationMs)}</span>;
  if (row.status === 'running' && row.startedAt !== undefined) return <Elapsed start={row.startedAt} />;
  return <span>-</span>;
}
