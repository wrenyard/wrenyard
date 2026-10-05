import { Brain, ChevronDown, ChevronRight, FileText, Paperclip, TriangleAlert, Zap } from 'lucide-react';
import { AppMarkdown as Markdown } from '@/renderer/components/app-markdown';
import { Timestamp } from '@/renderer/components/timestamp';
import { formatElapsedMs, formatTokenCount } from '@/renderer/lib/format';
import { cn } from 'cn';
import { shortName } from '../../../model/describe.js';
import type { TreeEntry } from '../../../model/types.js';
import { useTreeExpansion } from './expansion.js';

const KIND_LABEL: Record<TreeEntry['kind'], string> = {
  call: '调用',
  memory: '记忆',
  doc: '文档',
  file: '文件',
  error: '错误',
};

function KindIcon({ kind }: { kind: TreeEntry['kind'] }) {
  if (kind === 'memory') return <Brain className="size-3.5 shrink-0 text-chart-1" />;
  if (kind === 'doc') return <FileText className="size-3.5 shrink-0 text-muted-foreground" />;
  if (kind === 'file') return <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />;
  if (kind === 'error') return <TriangleAlert className="size-3.5 shrink-0 text-warning" />;
  return <Zap className="size-3.5 shrink-0 text-chart-2" />;
}

/** Short display name: documents and memories use their file name. */
function displayName(entry: TreeEntry): string {
  if ((entry.kind === 'doc' || entry.kind === 'memory' || entry.kind === 'file') && entry.path !== undefined && entry.path !== '') {
    return shortName(entry.path);
  }
  return entry.label;
}

function metric(entry: TreeEntry): string | undefined {
  if (entry.tokens !== undefined) return `${formatTokenCount(entry.tokens)} token`;
  if (entry.inputTokens !== undefined || entry.outputTokens !== undefined) {
    return `${formatTokenCount(entry.inputTokens ?? 0)} 输入 · ${formatTokenCount(entry.outputTokens ?? 0)} 输出`;
  }
  return undefined;
}

function EntryBody({ entry }: { entry: TreeEntry }) {
  const text = entry.body ?? '';
  return (
    <div className="ml-[15px] flex flex-col gap-1 border-l border-border/70 py-1 pr-2 pl-3.5">
      {entry.path !== undefined && entry.path !== '' && (
        <span className="break-all text-xs text-muted-foreground">{entry.path}</span>
      )}
      {entry.kind === 'call' || entry.kind === 'error'
        ? <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{text}</pre>
        : <Markdown>{text}</Markdown>}
    </div>
  );
}

export interface EntryRowProps {
  entry: TreeEntry;
  nodeId: string;
  /** Nesting depth; each level adds one indent step. */
  indent?: number;
}

/** One compact ledger-like entry row with an expandable body. */
export function EntryRow({ entry, nodeId, indent = 0 }: EntryRowProps) {
  const { isOpen, toggle } = useTreeExpansion();
  const expandable = entry.body !== undefined && entry.body !== '';
  const open = expandable && isOpen(nodeId);
  const metricText = metric(entry);
  const dim = entry.unchanged === true;
  const warning = entry.kind === 'error';

  return (
    <div className="flex flex-col">
      <button
        type="button"
        title={entry.path ?? entry.label}
        onClick={() => { if (expandable) toggle(nodeId); }}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg py-1 pr-2 text-left text-sm transition-colors hover:bg-muted/60',
          dim && 'opacity-60',
        )}
        style={{ paddingLeft: `${8 + indent * 16}px` }}
      >
        {expandable
          ? (open
            ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />)
          : <span className="size-3.5 shrink-0" />}
        <KindIcon kind={entry.kind} />
        <Timestamp value={entry.at} precision="second" className="shrink-0 text-xs text-muted-foreground" />
        <span className="shrink-0 text-xs text-muted-foreground">{KIND_LABEL[entry.kind]}</span>
        <span className={cn('min-w-0 flex-1 truncate', warning && 'text-warning')}>{displayName(entry)}</span>
        {dim && <span className="shrink-0 text-xs text-muted-foreground">已在上下文中</span>}
        {metricText !== undefined && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{metricText}</span>}
        {entry.durationMs !== undefined && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatElapsedMs(entry.durationMs)}</span>
        )}
      </button>
      {open && <EntryBody entry={entry} />}
    </div>
  );
}
