import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/renderer/components/ui/table';
import { formatCost } from '@/renderer/lib/format';
import type { QuotaSnapshot } from '@/shell-contract';
import { CALL_ROLE_LABEL } from '../../../model/describe.js';
import { callCost } from '../../../model/usage.js';
import type { CallModel } from '../../../model/types.js';
import { Section } from '../parts.js';

const ROLE_ORDER: readonly CallModel['role'][] = ['reason', 'select', 'interpret', 'compile', 'write', 'reply', 'title'];

interface RoleSummary {
  role: CallModel['role'];
  calls: CallModel[];
  ok: number;
  failed: number;
  aborted: number;
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
  /** Undefined when any call's price is unknown; never a partial zero. */
  fee: number | undefined;
}

function summarizeRole(role: CallModel['role'], calls: readonly CallModel[], quota: QuotaSnapshot | undefined): RoleSummary {
  const summary: RoleSummary = {
    role,
    calls: [...calls],
    ok: 0,
    failed: 0,
    aborted: 0,
    input: 0,
    cachedInput: 0,
    output: 0,
    reasoning: 0,
    fee: quota === undefined ? undefined : 0,
  };
  for (const call of calls) {
    if (call.status === 'ok') summary.ok += 1;
    else if (call.status === 'failed') summary.failed += 1;
    else if (call.status === 'aborted') summary.aborted += 1;
    summary.input += call.usage?.input ?? 0;
    summary.cachedInput += call.usage?.cachedInput ?? 0;
    summary.output += call.usage?.output ?? 0;
    summary.reasoning += call.usage?.reasoning ?? 0;
    if (summary.fee !== undefined && quota !== undefined) {
      const cost = callCost(call, quota);
      if (cost === undefined) summary.fee = undefined;
      else summary.fee += cost;
    }
  }
  return summary;
}

function FeeTotal({ label, value }: { label: string; value: number | undefined }) {
  return <span>{`${label} ${formatCost(value)}`}</span>;
}

export interface CallSummaryProps {
  calls: readonly CallModel[];
  quota: QuotaSnapshot | undefined;
}

/** Per-role call counts and token totals, with the reasoning-call detail and fee totals. */
export function CallSummary({ calls, quota }: CallSummaryProps) {
  const [expanded, setExpanded] = useState(false);
  const summaries = useMemo(() => ROLE_ORDER
    .map((role) => summarizeRole(role, calls.filter((call) => call.role === role), quota))
    .filter((summary) => summary.calls.length > 0), [calls, quota]);

  if (summaries.length === 0) return <p className="text-sm text-muted-foreground">还没有模型调用</p>;

  const reason = summaries.find((summary) => summary.role === 'reason');
  const cheapSummaries = summaries.filter((summary) => summary.role !== 'reason');
  const cheapFee = cheapSummaries.some((summary) => summary.fee === undefined)
    ? undefined
    : cheapSummaries.reduce((sum, summary) => sum + (summary.fee ?? 0), 0);
  const reasonFee = reason ? reason.fee : 0;
  const totalFee = reasonFee !== undefined && cheapFee !== undefined ? reasonFee + cheapFee : undefined;

  return (
    <Section title="调用">
      <div className="flex flex-col gap-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>角色</TableHead>
              <TableHead className="text-right">成功 / 失败 / 中止</TableHead>
              <TableHead className="text-right">输入（缓存）</TableHead>
              <TableHead className="text-right">输出（推理）</TableHead>
              <TableHead className="text-right">缓存命中</TableHead>
              <TableHead className="text-right">费用</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summaries.map((summary) => {
              const cacheHit = summary.input > 0 ? summary.cachedInput / summary.input : undefined;
              return (
                <TableRow key={summary.role}>
                  <TableCell>
                    {summary.role === 'reason' ? (
                      <button
                        type="button"
                        className="flex items-center gap-1 hover:text-foreground"
                        aria-expanded={expanded}
                        onClick={() => setExpanded((value) => !value)}
                      >
                        {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        {CALL_ROLE_LABEL[summary.role]}
                      </button>
                    ) : CALL_ROLE_LABEL[summary.role]}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{`${summary.ok} / ${summary.failed} / ${summary.aborted}`}</TableCell>
                  <TableCell className="text-right tabular-nums">{`${summary.input.toLocaleString()}（${summary.cachedInput.toLocaleString()}）`}</TableCell>
                  <TableCell className="text-right tabular-nums">{`${summary.output.toLocaleString()}（${summary.reasoning.toLocaleString()}）`}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {cacheHit === undefined ? '—' : <span className={cacheHit < 0.5 ? 'text-warning' : undefined}>{`${Math.round(cacheHit * 100)}%`}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCost(summary.fee)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {expanded && reason && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>推理调用</TableHead>
                <TableHead>模型</TableHead>
                <TableHead className="text-right">估算</TableHead>
                <TableHead className="text-right">实际</TableHead>
                <TableHead className="text-right">估算 / 实际</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reason.calls.map((call) => {
                const actual = call.usage?.input;
                const estimated = call.estimatedInputTokens;
                const ratio = actual !== undefined && estimated !== undefined && estimated > 0 ? actual / estimated : undefined;
                return (
                  <TableRow key={call.id}>
                    <TableCell className="tabular-nums">{`T${call.turn}${call.cycle !== undefined ? ` · C${call.cycle}` : ''}`}</TableCell>
                    <TableCell className="truncate">{call.model}</TableCell>
                    <TableCell className="text-right tabular-nums">{estimated === undefined ? '—' : estimated.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{actual === undefined ? '—' : actual.toLocaleString()}</TableCell>
                    <TableCell className={`text-right tabular-nums ${ratio !== undefined && ratio > 1.15 ? 'text-warning' : ''}`}>
                      {ratio === undefined ? '—' : `×${ratio.toFixed(2)}`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <FeeTotal label="总费用" value={totalFee} />
          <FeeTotal label="昂贵调用" value={reasonFee} />
          <FeeTotal label="便宜调用" value={cheapFee} />
        </div>
      </div>
    </Section>
  );
}
