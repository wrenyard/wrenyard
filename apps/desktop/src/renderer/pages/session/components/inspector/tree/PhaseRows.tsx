import { Brain, FileText, MessageCircle, TriangleAlert } from 'lucide-react';
import { AppMarkdown as Markdown } from '@/renderer/components/app-markdown';
import { Reasoning } from '@/renderer/components/chat/reasoning';
import { formatTokenCount } from '@/renderer/lib/format';
import type { CycleItem, CycleNode } from '../../../model/types.js';
import { ActionRow } from './ActionRow.js';
import { EntryRow } from './EntryRow.js';
import { entryNodeId } from './ids.js';

const COLLAPSE_LINES = 12;

function ReasonText({ text }: { text: string }) {
  const body = <Markdown>{text}</Markdown>;
  return text.split('\n').length <= COLLAPSE_LINES ? body : <div className="max-h-64 overflow-hidden scroll-fade-b">{body}</div>;
}

function TranscriptItem({ turn, cycle, item, index }: { turn: number; cycle: CycleNode; item: CycleItem; index: number }) {
  if (item.kind === 'entry') return <EntryRow entry={item.entry} nodeId={entryNodeId(turn, cycle.cycle, 'item', index)} />;
  if (item.kind === 'action') return <ActionRow action={item.action} />;
  if (item.kind === 'reply') return <div className="flex items-start gap-2 px-2 py-1 text-sm"><MessageCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /><Markdown>{item.text}</Markdown></div>;
  if (item.kind === 'error' || item.kind === 'notice') return <div className="flex items-start gap-2 px-2 py-1 text-xs text-warning"><TriangleAlert className="size-3.5 shrink-0" />{item.text}</div>;
  const reason = item.reason;
  return (
    <div className="flex flex-col gap-1 px-2 py-1">
      {reason.thinking && <Reasoning streaming={false} defaultOpen={false} title={`思考过程 · ${formatTokenCount(Math.max(1, Math.round(reason.thinking.length / 4)))} token`}>{reason.thinking}</Reasoning>}
      {reason.text && <ReasonText text={reason.text} />}
      {reason.actions.map((action) => <ActionRow key={action.id} action={action} />)}
    </div>
  );
}

export interface PhaseRowsProps { turn: number; cycle: CycleNode }

/** Ordered native transcript rows for one reasoning step. */
export function PhaseRows({ turn, cycle }: PhaseRowsProps) {
  return <div className="flex flex-col">{cycle.items.map((item, index) => <TranscriptItem key={`${item.kind}:${item.seq}:${index}`} turn={turn} cycle={cycle} item={item} index={index} />)}</div>;
}
