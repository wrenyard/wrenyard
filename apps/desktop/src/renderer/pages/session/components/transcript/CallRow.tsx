/**
 * Transcript cards for model calls: a compact auxiliary call row and the
 * cycle's reasoning card. Both wrap {@link ToolCard} and share the same timing
 * and token metadata, including the time to first token.
 */
import { useState } from 'react';
import { ChevronRight, Sparkles, Zap } from 'lucide-react';
import { cn } from 'cn';
import { AppMarkdown } from '@/renderer/components/app-markdown';
import { Elapsed } from '@/renderer/components/elapsed';
import { Spinner } from '@/renderer/components/ui/spinner';
import { elapsedBetween, formatElapsedMs, formatTokenCount } from '@/renderer/lib/format';
import { CALL_ROLE_LABEL, callRouteChips } from '../../model/describe.js';
import type { CallModel, ReasoningModel } from '../../model/types.js';
import { ToolCard } from './ToolCard.js';

/** Time to first output token, derived from the span's first-token stamp. */
function ttftMs(call: CallModel): number | undefined {
  if (call.firstTokenAt === undefined) return undefined;
  return elapsedBetween(call.startedAt, call.firstTokenAt, 0);
}

/** Timing and token metadata shared by the auxiliary and reasoning cards. */
function CallMeta({ call }: { call: CallModel }) {
  const ttft = ttftMs(call);
  const input = call.usage?.input;
  const output = call.usage?.output;
  return (
    <>
      {ttft !== undefined && <span>首字 {formatElapsedMs(ttft)}</span>}
      <Elapsed start={call.startedAt} end={call.endedAt} />
      {(input !== undefined || output !== undefined) && (
        <span>{formatTokenCount(input)}→{formatTokenCount(output)}</span>
      )}
    </>
  );
}

/** Compact status slot: a spinner while running, else a terminal word. */
function CallStatus({ call }: { call: CallModel }) {
  if (call.status === 'running') return <Spinner className="size-3" />;
  if (call.status === 'failed') return <span className="text-xs text-destructive">失败</span>;
  if (call.status === 'aborted') return <span className="text-xs text-muted-foreground">已取消</span>;
  return null;
}

export interface CallRowProps {
  /** The auxiliary call to render. */
  call: CallModel;
}

/** One auxiliary call as a compact transcript card. */
export function CallRow({ call }: CallRowProps) {
  const running = call.status === 'running';
  const chips = callRouteChips(call);
  const reasoning = call.reasoning ?? '';
  return (
    <ToolCard
      icon={<Zap />}
      label={CALL_ROLE_LABEL[call.role] ?? call.role}
      detail={call.model}
      meta={<CallMeta call={call} />}
      status={<CallStatus call={call} />}
      running={running}
      defaultOpen={false}
    >
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chips.map((chip) => (
            <span key={chip} className="rounded-full bg-muted px-2 py-0.5 text-xs">{chip}</span>
          ))}
        </div>
      )}
      {call.output !== '' && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono text-xs">{call.output}</pre>
      )}
      {reasoning !== '' && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono text-xs">{reasoning}</pre>
      )}
      {call.error !== undefined && call.error !== '' && <p className="text-destructive">{call.error}</p>}
    </ToolCard>
  );
}

export interface ReasoningCardProps {
  /** The reasoning span's call. */
  call: CallModel;
  /** The cycle's live reasoning, preferred over the call output when present. */
  reasoning?: ReasoningModel;
}

/**
 * The reasoning span of one cycle as a transcript card: the thinking first when
 * present, then the reasoning text, preferring the live streamed cycle text.
 */
export function ReasoningCard({ call, reasoning }: ReasoningCardProps) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const running = call.status === 'running';
  // Prefer the live streamed cycle text, then the committed call output.
  const liveText = reasoning?.text ?? '';
  const text = liveText !== '' ? liveText : call.output;
  const liveThinking = reasoning?.thinking ?? '';
  const thinking = liveThinking !== '' ? liveThinking : call.reasoning;
  return (
    <ToolCard
      icon={<Sparkles />}
      label={running ? '推理中' : '推理'}
      detail={call.model}
      meta={<CallMeta call={call} />}
      status={<CallStatus call={call} />}
      running={running}
      defaultOpen={running}
    >
      {thinking !== undefined && thinking !== '' && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            aria-expanded={thinkingOpen}
            className="flex w-full items-center gap-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setThinkingOpen((value) => !value)}
          >
            <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', thinkingOpen && 'rotate-90')} />
            <span>思考</span>
          </button>
          {thinkingOpen && (
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">{thinking}</p>
          )}
        </div>
      )}
      {text !== '' && (
        <AppMarkdown streaming={reasoning?.streaming ?? false} className="text-sm">{text}</AppMarkdown>
      )}
      {call.error !== undefined && call.error !== '' && <p className="text-destructive">{call.error}</p>}
    </ToolCard>
  );
}
