import { BrandIcon } from '@/renderer/components/brand-icon';
import { Card, CardContent, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/renderer/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { formatCount, formatTokenCount } from '@/renderer/lib/format';
import { PROFILE_EMPTY, PROFILE_PROVIDER_PREFIX, PROFILE_TITLE } from '../model/describe.js';
import type { ProfileRow } from '../model/stats.js';

/** Per-model run, token and TPS totals; providers appear only in a tooltip. */
export function ProfileTable({ rows }: { rows: ProfileRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{PROFILE_TITLE}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>模型</TableHead>
              <TableHead className="text-right">运行</TableHead>
              <TableHead className="text-right">Token</TableHead>
              <TableHead className="text-right">TPS</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">{PROFILE_EMPTY}</TableCell>
              </TableRow>
            ) : rows.map((row, index) => (
              <TableRow key={`${row.key}:${index}`}>
                <TableCell><ModelCell row={row} /></TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(row.runCount)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatTokenCount(row.totalTokens)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.averageTps === undefined ? '—' : row.averageTps.toFixed(2)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ModelCell({ row }: { row: ProfileRow }) {
  const content = (
    <span className="inline-flex items-center gap-1.5">
      {row.brand !== '' && <BrandIcon brand={row.brand} />}
      <span>{row.displayName}</span>
    </span>
  );
  if (row.providers.length === 0) return content;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{content}</TooltipTrigger>
      <TooltipContent>{`${PROFILE_PROVIDER_PREFIX}${row.providers.join('、')}`}</TooltipContent>
    </Tooltip>
  );
}
