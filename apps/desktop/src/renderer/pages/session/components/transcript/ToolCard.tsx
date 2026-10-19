/**
 * Expandable context rows shared by the transcript: a compact header with a
 * kind icon over the item's content, and the bare content body used by the
 * activity groups.
 */
import { useState } from 'react';
import {
  BookText,
  Brain,
  ChevronRight,
  FileText,
  Paperclip,
  Search,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { cn } from 'cn';
import { AppMarkdown } from '@/renderer/components/app-markdown';
import { materialTitle } from '../../model/describe.js';
import type { ContextItem, ContextItemKindModel } from '../../model/types.js';

const CONTEXT_ICON: Record<ContextItemKindModel, LucideIcon> = {
  memory: Brain,
  doc: FileText,
  instructions: BookText,
  search: Search,
  files: Paperclip,
  thinking: Sparkles,
  error: TriangleAlert,
};

/** The bare content of one context item, as the transcript renders it. */
export function ContextItemBody({ item }: { item: ContextItem }) {
  return item.format === 'diff' ? (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono text-xs">{item.content}</pre>
  ) : (
    <AppMarkdown className="text-sm">{item.content}</AppMarkdown>
  );
}

/** One context row: kind icon, title, optional reason, then its content. */
function ContextRow({ item }: { item: ContextItem }) {
  const [open, setOpen] = useState(false);
  const Icon = CONTEXT_ICON[item.kind];
  const reason = item.reason?.trim() ?? '';
  return (
    <div className="rounded-md border bg-background/40">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/50"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{materialTitle(item)}</span>
        {reason !== '' && <span className="min-w-0 max-w-[50%] truncate text-xs text-muted-foreground">{reason}</span>}
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="border-t px-2 py-1.5">
          <ContextItemBody item={item} />
        </div>
      )}
    </div>
  );
}

export interface ContextItemsProps {
  /** Context items to render as compact expandable rows. */
  items: readonly ContextItem[];
  className?: string;
}

/** Renders context items as compact expandable rows with kind-specific icons. */
export function ContextItems({ items, className }: ContextItemsProps) {
  if (items.length === 0) return null;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {items.map((item) => <ContextRow key={item.key} item={item} />)}
    </div>
  );
}
