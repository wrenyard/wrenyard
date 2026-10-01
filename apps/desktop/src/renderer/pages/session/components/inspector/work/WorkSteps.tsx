import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { FileText, MessageCircle, Sparkles } from 'lucide-react';
import { Alert, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { Item, ItemContent, ItemMedia } from '@/renderer/components/ui/item';
import { Marker, MarkerContent, MarkerIcon } from '@/renderer/components/ui/marker';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { Elapsed } from '@/renderer/components/elapsed';
import { Markdown } from '@/renderer/components/markdown';
import { Reasoning } from '@/renderer/components/chat/reasoning';
import { CYCLE_LIMIT_TOOLTIP, PHASE_LABEL, cycleLabel } from '../../../model/describe.js';
import type { ActionModel, CycleModel, ErrorItem, ReplyModel, TurnModel } from '../../../model/types.js';
import { ActionMark } from './ActionMark.js';
import { ActionRow } from './ActionRow.js';
import { ContextItems } from './ContextItems.js';
import { useInspector } from '../Inspector.js';

const COLLAPSE_LINES = 12;

function timeOf(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Prepared context, labelled with how many materials were loaded. */
function Preparation({ cycle, turnId }: { cycle: CycleModel; turnId: number }) {
  return (
    <section className="flex flex-col gap-1.5">
      <Marker>
        <MarkerIcon><FileText /></MarkerIcon>
        <MarkerContent>
          {cycle.context.length === 0 ? '未加载新资料' : `加载了 ${cycle.context.length} 份资料`}
        </MarkerContent>
      </Marker>
      {cycle.context.length > 0 && <ContextItems items={cycle.context} turnId={turnId} cycle={cycle.index} />}
    </section>
  );
}

/** Reasoning text split on `<wy-action>` markers, collapsing long streams. */
function ReasoningText({ cycle, turnId }: { cycle: CycleModel; turnId: number }) {
  const [open, setOpen] = useState(false);
  const text = cycle.reasoning?.text ?? '';
  const streaming = cycle.reasoning?.streaming ?? false;
  const parts = text.split(/<wy-action>|<\/wy-action>/);
  const body = parts.length > 1 ? (
    <div className="flex flex-col">
      {parts.map((part, index) => {
        if (index % 2 === 1) {
          const block = cycle.blocks[(index - 1) / 2];
          return block
            ? <ActionMark key={index} block={block} turnId={turnId} actionCount={block.actionIds.length} />
            : <Markdown key={index} streaming={streaming}>{`<wy-action>${part}</wy-action>`}</Markdown>;
        }
        return <Markdown key={index} streaming={streaming}>{part}</Markdown>;
      })}
    </div>
  ) : <Markdown streaming={streaming}>{text}</Markdown>;

  if (text.split('\n').length <= COLLAPSE_LINES) return body;
  return (
    <div className="flex flex-col">
      <div className={open ? undefined : 'max-h-64 overflow-hidden scroll-fade-b'}>{body}</div>
      <Button variant="ghost" onClick={() => setOpen((value) => !value)}>{open ? '收起' : '展开全文'}</Button>
    </div>
  );
}

/** Reasoning segment with a jump link to the full reasoning detail. */
function ReasoningSection({ cycle, turnId }: { cycle: CycleModel; turnId: number }) {
  const { inspect } = useInspector();
  const streaming = cycle.reasoning?.streaming ?? false;
  return (
    <section className="flex flex-col gap-1.5">
      <Marker
        render={<button type="button" />}
        onClick={() => inspect({ kind: 'reasoning', turnId, cycle: cycle.index })}
      >
        <MarkerIcon><Sparkles /></MarkerIcon>
        <MarkerContent className={streaming ? 'shimmer' : undefined}>{PHASE_LABEL.reasoning}</MarkerContent>
      </Marker>
      {cycle.reasoning ? (
        <>
          <ReasoningText cycle={cycle} turnId={turnId} />
          {cycle.reasoning.thinking && <Reasoning streaming={cycle.reasoning.streaming}>{cycle.reasoning.thinking}</Reasoning>}
        </>
      ) : (
        <div className="flex flex-col gap-1">
          {cycle.blocks.map((block) => (
            <ActionMark key={block.blockId} block={block} turnId={turnId} actionCount={block.actionIds.length} />
          ))}
        </div>
      )}
    </section>
  );
}

function ProgressItem({ reply }: { reply: ReplyModel }) {
  return (
    <Item variant="muted">
      <ItemMedia variant="icon" className="text-muted-foreground"><MessageCircle /></ItemMedia>
      <ItemContent className="text-muted-foreground">
        <Markdown>{reply.text}</Markdown>
      </ItemContent>
    </Item>
  );
}

function ErrorAlert({ error }: { error: ErrorItem }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}

interface WorkEntry {
  key: string;
  at: number;
  node: ReactNode;
}

/** Ordered work items: preparation, reasoning, actions, progress and errors. */
function buildEntries(turn: TurnModel, cycle: CycleModel, actions: ActionModel[]): WorkEntry[] {
  const entries: WorkEntry[] = [
    { key: 'preparation', at: timeOf(cycle.startedAt), node: <Preparation cycle={cycle} turnId={turn.id} /> },
  ];
  if (cycle.reasoning || cycle.blocks.length > 0) {
    const reasonCall = cycle.reasoning ? turn.calls.find((call) => call.id === cycle.reasoning!.callId) : undefined;
    entries.push({
      key: 'reasoning',
      at: timeOf(reasonCall?.startedAt ?? cycle.startedAt),
      node: <ReasoningSection cycle={cycle} turnId={turn.id} />,
    });
  }
  for (const action of actions) {
    entries.push({ key: `action-${action.id}`, at: timeOf(action.startedAt), node: <ActionRow action={action} turnId={turn.id} /> });
  }
  cycle.progress.forEach((reply, index) => {
    entries.push({ key: `progress-${reply.at}-${index}`, at: timeOf(reply.at), node: <ProgressItem reply={reply} /> });
  });
  cycle.errors.forEach((error, index) => {
    entries.push({ key: `error-${error.at}-${index}`, at: timeOf(error.at), node: <ErrorAlert error={error} /> });
  });
  return entries.sort((a, b) => a.at - b.at);
}

export interface CycleWorkProps {
  turn: TurnModel;
  cycle: CycleModel;
}

/** Complete work of one reasoning cycle, for the inspector detail pane. */
export function CycleWork({ turn, cycle }: CycleWorkProps) {
  const actions = useMemo(
    () => turn.actions.filter((action) => action.cycle === cycle.index),
    [turn.actions, cycle.index],
  );
  const entries = useMemo(() => buildEntries(turn, cycle, actions), [turn, cycle, actions]);
  return (
    <div className="flex flex-col gap-3">
      {entries.map((entry) => <Fragment key={entry.key}>{entry.node}</Fragment>)}
    </div>
  );
}

export interface WorkStepsProps {
  turn: TurnModel;
}

/** Expanded work process: one labelled divider per reasoning cycle. */
export function WorkSteps({ turn }: WorkStepsProps) {
  if (turn.cycles.length === 0) {
    return <p className="text-muted-foreground">还没有可展开的工作过程</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {turn.cycles.map((cycle) => {
        const divider = (
          <Marker variant="separator">
            <MarkerContent>
              {cycleLabel(cycle.index)} · <Elapsed start={cycle.startedAt} end={cycle.endedAt} />
            </MarkerContent>
          </Marker>
        );
        return (
          <Fragment key={cycle.index}>
            {cycle.index >= 8 ? (
              <Tooltip>
                <TooltipTrigger render={divider} />
                <TooltipContent>{CYCLE_LIMIT_TOOLTIP}</TooltipContent>
              </Tooltip>
            ) : (
              divider
            )}
            <CycleWork turn={turn} cycle={cycle} />
          </Fragment>
        );
      })}
    </div>
  );
}
