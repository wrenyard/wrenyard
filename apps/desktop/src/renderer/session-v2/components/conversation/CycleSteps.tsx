import { useMemo, useState } from 'react';
import { MessageCircle, Zap } from 'lucide-react';
import { Alert, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { Elapsed } from '@/renderer/components/elapsed';
import { Markdown } from '@/renderer/components/markdown';
import { Reasoning } from '@/renderer/components/chat/reasoning';
import { Step, Steps } from '@/renderer/components/chat/steps';
import { CYCLE_LIMIT_TOOLTIP, PHASE_LABEL, cycleLabel } from '../../model/describe.js';
import type { ActionModel, BlockModel, CycleModel, TurnModel } from '../../model/types.js';
import { ActionRow } from './ActionRow.js';
import { ContextItems } from './ContextItems.js';
import { useInspector } from '../inspector/Inspector.js';

function ActionMark({ block, turnId, actionCount }: { block: BlockModel; turnId: number; actionCount: number }) {
  const { inspect } = useInspector();
  const firstLine = block.text.split('\n', 1)[0] ?? '';
  return (
    <Button variant="ghost" size="xs" className="my-1 h-auto w-full justify-start py-1 text-left"
      onClick={() => inspect({ kind: 'block', turnId, blockId: block.blockId })}>
      <Zap className="size-3.5 text-[var(--lamp-deep)]" />
      <span className="truncate">{firstLine}</span>
      <span className="shrink-0 text-muted-foreground">→ {actionCount} 个行动</span>
    </Button>
  );
}

function ReasoningBody({ text, blocks, turnId }: { text: string; blocks: BlockModel[]; turnId: number }) {
  const [open, setOpen] = useState(false);
  const lineCount = text.split('\n').length;
  const parts = text.split(/<wy-action>|<\/wy-action>/);
  const body = parts.length > 1 ? (
    <div className="flex flex-col">
      {parts.map((part, index) => {
        if (index % 2 === 1) {
          const block = blocks[(index - 1) / 2];
          return block
            ? <ActionMark key={index} block={block} turnId={turnId} actionCount={block.actionIds.length} />
            : <Markdown key={index} size="sm">{`<wy-action>${part}</wy-action>`}</Markdown>;
        }
        return part.trim() === '' ? null : <Markdown key={index} size="sm">{part}</Markdown>;
      })}
    </div>
  ) : <Markdown size="sm">{text}</Markdown>;

  if (lineCount <= 12) return body;
  return (
    <div className="relative">
      <div className={open ? undefined : 'max-h-64 overflow-hidden'}>{body}</div>
      {!open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background to-transparent" />}
      <Button variant="ghost" size="xs" onClick={() => setOpen((value) => !value)}>{open ? '收起' : '展开全文'}</Button>
    </div>
  );
}

function CycleBody({ cycle, actions, turnId }: { cycle: CycleModel; actions: ActionModel[]; turnId: number }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <section className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{PHASE_LABEL.preparing}</span>
        <ContextItems items={cycle.context} turnId={turnId} cycle={cycle.index} />
      </section>

      {(cycle.reasoning || cycle.blocks.length > 0) && (
        <section className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{PHASE_LABEL.reasoning}</span>
          {cycle.reasoning
            ? <>
                <ReasoningBody text={cycle.reasoning.text} blocks={cycle.blocks} turnId={turnId} />
                {cycle.reasoning.thinking && <Reasoning streaming={cycle.reasoning.streaming}>{cycle.reasoning.thinking}</Reasoning>}
              </>
            : <div className="flex flex-col gap-1">
                {cycle.blocks.map((block) => (
                  <ActionMark key={block.blockId} block={block} turnId={turnId} actionCount={block.actionIds.length} />
                ))}
              </div>}
        </section>
      )}

      {actions.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{PHASE_LABEL.acting}</span>
          {actions.map((action) => <ActionRow key={action.id} action={action} turnId={turnId} />)}
        </section>
      )}

      {cycle.progress.map((reply, index) => (
        <div key={`${reply.at}-${index}`} className="flex items-start gap-2 text-xs text-muted-foreground">
          <MessageCircle className="mt-0.5 size-3.5 shrink-0" />
          <Markdown size="sm">{reply.text}</Markdown>
        </div>
      ))}

      {cycle.errors.map((error, index) => (
        <Alert key={`${error.at}-${index}`} variant="destructive" className="px-2 py-1.5 text-xs">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ))}
    </div>
  );
}

export interface CycleStepsProps {
  turn: TurnModel;
}

/** Expanded work process: one step group per reasoning cycle. */
export function CycleSteps({ turn }: CycleStepsProps) {
  const actionsByCycle = useMemo(() => {
    const map = new Map<number, ActionModel[]>();
    for (const action of turn.actions) {
      const bucket = map.get(action.cycle);
      if (bucket) bucket.push(action);
      else map.set(action.cycle, [action]);
    }
    return map;
  }, [turn.actions]);

  if (turn.cycles.length === 0) {
    return <p className="text-xs text-muted-foreground">还没有可展开的工作过程</p>;
  }
  return (
    <Steps>
      {turn.cycles.map((cycle) => {
        const title = (
          <span className="flex items-center gap-2 text-xs">
            <span>{cycleLabel(cycle.index)}</span>
            <span className="text-muted-foreground">· <Elapsed start={cycle.startedAt} end={cycle.endedAt} /></span>
          </span>
        );
        return (
          <Step
            key={cycle.index}
            title={cycle.index >= 8
              ? <Tooltip><TooltipTrigger render={title} /><TooltipContent>{CYCLE_LIMIT_TOOLTIP}</TooltipContent></Tooltip>
              : title}
          >
            <CycleBody cycle={cycle} actions={actionsByCycle.get(cycle.index) ?? []} turnId={turn.id} />
          </Step>
        );
      })}
    </Steps>
  );
}
