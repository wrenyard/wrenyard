/**
 * Shared inline transcript card and expandable context rows.
 *
 * These are the two primitives the transcript view composes every collapsible
 * piece from: a compact header with a chevron over an optional body, and a
 * list of context items rendered as small expandable rows. The styling is the
 * redesigned agent-client treatment, not the retired ledger inspector tree.
 */
import { useState, type ReactNode } from 'react';
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

export interface ToolCardProps {
  /** Leading icon shown before the label. */
  icon: ReactNode;
  /** Primary label; shimmering while the card runs. */
  label: ReactNode;
  /** Optional muted detail rendered after the label. */
  detail?: ReactNode;
  /** Optional right-aligned metadata. */
  meta?: ReactNode;
  /** Optional status slot rendered after the metadata. */
  status?: ReactNode;
  /** Whether the underlying work is still in flight. */
  running?: boolean;
  /** Whether the body starts expanded; the user toggles it afterwards. */
  defaultOpen?: boolean;
  /** Card body, shown only while expanded. */
  children: ReactNode;
  className?: string;
}

/**
 * One collapsible transcript card: a compact clickable header with an icon,
 * label, detail and metadata, a highlighted border and an indeterminate sweep
 * strip while running, and a locally toggled body.
 */
export function ToolCard({
  icon,
  label,
  detail,
  meta,
  status,
  running = false,
  defaultOpen = false,
  children,
  className,
}: ToolCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn('overflow-hidden rounded-lg border bg-card/60', running && 'border-primary/40', className)}>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="shrink-0 text-muted-foreground [&_svg]:size-3.5">{icon}</span>
        <span className={cn('font-medium', running && 'shimmer')}>{label}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{detail}</span>
        <span className="inline-flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">{meta}</span>
        {status}
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </button>
      {running && (
        <span aria-hidden className="relative block h-0.5 overflow-hidden bg-primary/10">
          <span className="motion-aux-sweep absolute inset-y-0 left-0 w-2/5 rounded-full bg-primary/70" />
        </span>
      )}
      {open && <div className="flex flex-col gap-2 border-t px-3 py-2 text-sm">{children}</div>}
    </div>
  );
}

const CONTEXT_ICON: Record<ContextItemKindModel, LucideIcon> = {
  memory: Brain,
  doc: FileText,
  instructions: BookText,
  search: Search,
  files: Paperclip,
  thinking: Sparkles,
  error: TriangleAlert,
};

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
          {item.format === 'diff' ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono text-xs">{item.content}</pre>
          ) : (
            <AppMarkdown className="text-sm">{item.content}</AppMarkdown>
          )}
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
