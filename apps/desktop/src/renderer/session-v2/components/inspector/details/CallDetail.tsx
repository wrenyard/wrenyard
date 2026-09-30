import { Elapsed } from '@/renderer/components/elapsed';
import { Markdown } from '@/renderer/components/markdown';
import { StatusBadge } from '@/renderer/components/status-badge';
import { Timestamp } from '@/renderer/components/timestamp';
import { CALL_ROLE_LABEL, statusView } from '../../../model/describe.js';
import type { CallModel } from '../../../model/types.js';
import { Field, Section } from '../parts.js';

function UsageTable({ usage }: { usage: NonNullable<CallModel['usage']> }) {
  const rows: [string, number | undefined][] = [
    ['输入', usage.input],
    ['缓存输入', usage.cachedInput],
    ['输出', usage.output],
    ['推理', usage.reasoning],
  ];
  return (
    <div className="overflow-hidden rounded-md border border-border text-xs">
      <table className="w-full">
        <tbody>
          {rows.filter((row): row is [string, number] => row[1] !== undefined).map(([label, value]) => (
            <tr key={label} className="border-b border-border last:border-0">
              <td className="px-2 py-1 text-muted-foreground">{label}</td>
              <td className="px-2 py-1 text-right font-mono">{value.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Layers({ layers }: { layers: Record<string, number> }) {
  const entries = Object.entries(layers).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, value]) => value));
  return (
    <div className="flex flex-col gap-1">
      {entries.map(([name, value]) => (
        <div key={name} className="grid grid-cols-[8rem_1fr_3.5rem] items-center gap-2 text-xs">
          <span className="truncate text-muted-foreground">{name}</span>
          <span className="h-2 rounded-full bg-primary/60" style={{ width: `${(value / max) * 100}%` }} />
          <span className="text-right font-mono">{value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

/** One model call: timing, usage, layers, output and thinking. */
export function CallDetail({ call }: { call: CallModel }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{CALL_ROLE_LABEL[call.role]} · {call.model}</span>
        <StatusBadge {...statusView(call.status)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Field label="开始"><Timestamp value={call.startedAt} precision="second" className="font-mono text-xs" /></Field>
        {call.endedAt && <Field label="结束"><Timestamp value={call.endedAt} precision="second" className="font-mono text-xs" /></Field>}
        <Field label="首 token">{call.firstTokenAt ? <Elapsed start={call.startedAt} end={call.firstTokenAt} /> : '—'}</Field>
        <Field label="总用时"><Elapsed start={call.startedAt} end={call.endedAt} /></Field>
        {call.estimatedInputTokens !== undefined && <Field label="估算输入">{call.estimatedInputTokens.toLocaleString()} token</Field>}
      </div>
      {call.usage && <Section title="用量"><UsageTable usage={call.usage} /></Section>}
      {call.layers && Object.keys(call.layers).length > 0 && <Section title="分层字符数"><Layers layers={call.layers} /></Section>}
      {call.error && <Section title="错误"><span className="text-sm text-destructive">{call.error}</span></Section>}
      {call.output && <Section title="输出"><Markdown size="sm">{call.output}</Markdown></Section>}
      {call.reasoning && (
        <Section title="Thinking">
          <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">{call.reasoning}</pre>
        </Section>
      )}
    </div>
  );
}
