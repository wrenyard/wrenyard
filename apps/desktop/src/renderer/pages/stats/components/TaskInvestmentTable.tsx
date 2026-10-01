import { Badge } from '@/renderer/components/ui/badge';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Label } from '@/renderer/components/ui/label';
import { Switch } from '@/renderer/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/renderer/components/ui/table';
import { formatCount, formatElapsedMs } from '@/renderer/lib/format';
import {
  SOURCE_LABEL,
  TASK_INVESTMENT_BUILTIN_EMPTY,
  TASK_INVESTMENT_EMPTY,
  TASK_INVESTMENT_TITLE,
  TASK_INVESTMENT_TOGGLE_LABEL,
} from '../model/describe.js';
import type { TaskRow } from '../model/stats.js';

/** Per-task run and duration totals with a builtin-only filter. */
export function TaskInvestmentTable({
  rows,
  builtinOnly,
  onBuiltinOnlyChange,
}: {
  rows: TaskRow[];
  builtinOnly: boolean;
  onBuiltinOnlyChange: (builtinOnly: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{TASK_INVESTMENT_TITLE}</CardTitle>
        <CardAction>
          <div className="flex items-center gap-2">
            <Label htmlFor="stats-builtin-only">{TASK_INVESTMENT_TOGGLE_LABEL}</Label>
            <Switch
              id="stats-builtin-only"
              checked={builtinOnly}
              onCheckedChange={onBuiltinOnlyChange}
            />
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>任务</TableHead>
              <TableHead>来源</TableHead>
              <TableHead className="text-right">运行</TableHead>
              <TableHead className="text-right">平均耗时</TableHead>
              <TableHead className="text-right">占比</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  {builtinOnly ? TASK_INVESTMENT_BUILTIN_EMPTY : TASK_INVESTMENT_EMPTY}
                </TableCell>
              </TableRow>
            ) : rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell>{row.label}</TableCell>
                <TableCell><Badge variant="secondary">{SOURCE_LABEL[row.source]}</Badge></TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(row.runCount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatElapsedMs(row.averageDurationMs)}</TableCell>
                <TableCell className="text-right tabular-nums">{row.shareLabel}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
