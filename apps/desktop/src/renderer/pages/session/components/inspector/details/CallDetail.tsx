import { Elapsed } from '@/renderer/components/elapsed';
import { Markdown } from '@/renderer/components/markdown';
import { StatusBadge } from '@/renderer/components/status-badge';
import { Item, ItemContent, ItemTitle } from '@/renderer/components/ui/item';
import { Table, TableBody, TableCell, TableRow } from '@/renderer/components/ui/table';
import { Timestamp } from '@/renderer/components/timestamp';
import { CALL_ROLE_LABEL, statusView } from '../../../model/describe.js';
import type { CallModel } from '../../../model/types.js';
import { Field, Fields, Section } from '../parts.js';

function UsageTable({ usage }: { usage: NonNullable<CallModel['usage']> }) {
  const rows: [string, number | undefined][] = [
    ['输入', usage.input],
    ['缓存输入', usage.cachedInput],
    ['输出', usage.output],
    ['推理', usage.reasoning],
  ];
  return (
    <Table>
      <TableBody>
        {rows.filter((row): row is [string, number] => row[1] !== undefined).map(([label, value]) => (
          <TableRow key={label}>
            <TableCell>{label}</TableCell>
            <TableCell className="text-right tabular-nums">{value.toLocaleString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Layers({ layers }: { layers: Record<string, number> }) {
  const entries = Object.entries(layers).sort((a, b) => b[1] - a[1]);
  return (
    <Table>
      <TableBody>
        {entries.map(([name, value]) => (
          <TableRow key={name}>
            <TableCell>{name}</TableCell>
            <TableCell className="text-right tabular-nums">{value.toLocaleString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** One model call: timing, usage, layers, output and thinking. */
export function CallDetail({ call }: { call: CallModel }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <ItemTitle>{CALL_ROLE_LABEL[call.role]} · {call.model}</ItemTitle>
        <StatusBadge {...statusView(call.status)} />
      </div>
      <Fields>
        <Field label="开始"><Timestamp value={call.startedAt} precision="second" /></Field>
        {call.endedAt && <Field label="结束"><Timestamp value={call.endedAt} precision="second" /></Field>}
        <Field label="首 token">{call.firstTokenAt ? <Elapsed start={call.startedAt} end={call.firstTokenAt} /> : '—'}</Field>
        <Field label="总用时"><Elapsed start={call.startedAt} end={call.endedAt} /></Field>
        {call.estimatedInputTokens !== undefined && <Field label="估算输入">{call.estimatedInputTokens.toLocaleString()} token</Field>}
      </Fields>
      {call.usage && <Section title="用量"><UsageTable usage={call.usage} /></Section>}
      {call.layers && Object.keys(call.layers).length > 0 && <Section title="分层字符数"><Layers layers={call.layers} /></Section>}
      {call.error && <Section title="错误"><span className="text-sm text-destructive">{call.error}</span></Section>}
      {call.output && <Section title="输出"><Markdown>{call.output}</Markdown></Section>}
      {call.reasoning && (
        <Section title="Thinking">
          <Item variant="muted">
            <ItemContent>
              <pre className="overflow-x-auto whitespace-pre-wrap">{call.reasoning}</pre>
            </ItemContent>
          </Item>
        </Section>
      )}
    </div>
  );
}
