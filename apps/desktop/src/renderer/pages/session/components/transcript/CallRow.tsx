/**
 * Transcript rows for model calls: the cycle's reasoning row and the compact
 * auxiliary call rows (standalone or nested inside an action). All of them
 * share the same timing and token metadata, including the time to first token.
 */
import { ArrowDown, ArrowUp } from 'lucide-react';
import { AppMarkdown } from '@/renderer/components/app-markdown';
import { Elapsed } from '@/renderer/components/elapsed';
import { elapsedBetween, formatElapsedMs, formatTokenCount } from '@/renderer/lib/format';
import { CALL_ROLE_LABEL, callRouteChips } from '../../model/describe.js';
import type { CallModel, ReasoningModel } from '../../model/types.js';
import { ActivityRow, ActivityRowStatus, OutputBox } from './ActivityRow.js';

/** Time to first output token, derived from the span's first-token stamp. */
function ttftMs(call: CallModel): number | undefined {
  if (call.firstTokenAt === undefined) return undefined;
  return elapsedBetween(call.startedAt, call.firstTokenAt, 0);
}

/** Timing and token metadata shared by the call rows and the dispatch input block. */
export function CallMeta({ call }: { call: CallModel }) {
  const ttft = ttftMs(call);
  const input = call.usage?.input;
  const output = call.usage?.output;
  return (
    <>
      {ttft !== undefined && <span>首字 {formatElapsedMs(ttft)}</span>}
      <Elapsed start={call.startedAt} end={call.endedAt} />
      {input !== undefined && (
        <span className="inline-flex items-center gap-0.5" title={`输入 ${formatTokenCount(input)}`}>
          <ArrowUp className="size-3" aria-label="输入" />{formatTokenCount(input)}
        </span>
      )}
      {output !== undefined && (
        <span className="inline-flex items-center gap-0.5" title={`输出 ${formatTokenCount(output)}`}>
          <ArrowDown className="size-3" aria-label="输出" />{formatTokenCount(output)}
        </span>
      )}
    </>
  );
}

/** The reasoning span of one cycle as an expandable row. */
export function ReasoningRow({ call, reasoning }: { call: CallModel; reasoning?: ReasoningModel }) {
  const thinking = reasoning?.thinking ?? '';
  // Prefer the live streamed cycle text, then the committed call output.
  const liveText = reasoning?.text ?? '';
  const text = liveText !== '' ? liveText : call.output;
  return (
    <ActivityRow
      verb="思考"
      subject={<span className="font-mono text-xs font-normal">{call.model}</span>}
      meta={<Elapsed start={call.startedAt} end={call.endedAt} />}
      openMeta={<CallMeta call={call} />}
      status={(
        <ActivityRowStatus
          running={call.status === 'running'}
          failed={call.status === 'failed'}
          cancelled={call.status === 'aborted'}
        />
      )}
      openWhile={(reasoning?.streaming ?? false) && call.status === 'running'}
    >
      {thinking !== '' && (
        <>
          <p className="text-xs text-muted-foreground">思考过程</p>
          <OutputBox>{thinking}</OutputBox>
        </>
      )}
      {text !== '' && (
        <AppMarkdown streaming={reasoning?.streaming ?? false} className="text-sm">{text}</AppMarkdown>
      )}
      {call.error !== undefined && <p className="text-destructive">{call.error}</p>}
    </ActivityRow>
  );
}

/** The details shared by every auxiliary call row. */
function CallRowBody({ call }: { call: CallModel }) {
  const chips = callRouteChips(call);
  const reasoning = call.reasoning ?? '';
  return (
    <>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chips.map((chip) => (
            <span key={chip} className="rounded-full bg-muted px-2 py-0.5 text-xs">{chip}</span>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground tabular-nums"><CallMeta call={call} /></p>
      {call.output !== '' && <OutputBox>{call.output}</OutputBox>}
      {reasoning !== '' && <OutputBox>{reasoning}</OutputBox>}
      {call.error !== undefined && <p className="text-destructive">{call.error}</p>}
    </>
  );
}

/** One auxiliary call of a cycle, as a step row. */
export function AuxiliaryCallRow({ call }: { call: CallModel }) {
  return (
    <ActivityRow
      verb={CALL_ROLE_LABEL[call.role] ?? call.role}
      subject={<span className="font-mono text-xs font-normal">{call.model}</span>}
      meta={<Elapsed start={call.startedAt} end={call.endedAt} />}
      openMeta={<CallMeta call={call} />}
      status={(
        <ActivityRowStatus
          running={call.status === 'running'}
          failed={call.status === 'failed'}
          cancelled={call.status === 'aborted'}
        />
      )}
    >
      <CallRowBody call={call} />
    </ActivityRow>
  );
}

/** One auxiliary call nested inside an action, as a compact step row. */
export function NestedCallRow({ call }: { call: CallModel }) {
  return (
    <ActivityRow
      verb={CALL_ROLE_LABEL[call.role] ?? call.role}
      subject={<span className="font-mono text-xs font-normal">{call.model}</span>}
      meta={<Elapsed start={call.startedAt} end={call.endedAt} />}
      openMeta={<CallMeta call={call} />}
      status={(
        <ActivityRowStatus
          running={call.status === 'running'}
          failed={call.status === 'failed'}
          cancelled={call.status === 'aborted'}
        />
      )}
      compact
    >
      <CallRowBody call={call} />
    </ActivityRow>
  );
}
