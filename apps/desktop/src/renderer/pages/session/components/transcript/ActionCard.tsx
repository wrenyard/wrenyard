/**
 * Inline transcript card for one action: its nested auxiliary calls, loaded
 * context, the dispatched task with its transcript and cancel controls, its
 * writes, the files it produced, and its result.
 */
import { useState } from 'react';
import {
  BookOpen,
  ChevronRight,
  ExternalLink,
  FilePenLine,
  FolderGit2,
  GitBranch,
  ListTodo,
  Send,
  Square,
  Timer,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { cn } from 'cn';
import { AppMarkdown } from '@/renderer/components/app-markdown';
import { Elapsed } from '@/renderer/components/elapsed';
import { StatusBadge } from '@/renderer/components/status-badge';
import { Button } from '@/renderer/components/ui/button';
import { Spinner } from '@/renderer/components/ui/spinner';
import { shell } from '@/renderer/lib/desktop';
import { formatTokenCount } from '@/renderer/lib/format';
import { statusView } from '../../model/describe.js';
import type { ActionKindModel, ActionModel, CallModel } from '../../model/types.js';
import { MediaAttachments, fromSessionFile } from '../MediaAttachments.js';
import { CallRow } from './CallRow.js';
import { ContextItems, ToolCard } from './ToolCard.js';

const ACTION_ICON: Record<ActionKindModel, LucideIcon> = {
  search: BookOpen,
  document: FilePenLine,
  dispatch: Send,
  vcs: GitBranch,
  project: FolderGit2,
  schedule: Timer,
  'parse-failed': TriangleAlert,
};

/** Dispatched task row: name, runtime, status, tokens, transcript and cancel. */
function TaskRow({ action, onCancelTask }: { action: ActionModel; onCancelTask: (taskRunId: string) => Promise<void> }) {
  const [cancelling, setCancelling] = useState(false);
  const task = action.task;
  const total = task?.usage?.totalTokens;
  const cancel = (): void => {
    if (action.taskRunId === undefined || cancelling) return;
    setCancelling(true);
    // Keep the spinner up on success; the action's own status settles it. A
    // rejected cancel clears the local flag and is swallowed here on purpose.
    onCancelTask(action.taskRunId).catch(() => setCancelling(false));
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs">
      <ListTodo className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="font-medium">{task?.taskName ?? '任务'}</span>
      {task?.runtime !== undefined && <span className="text-muted-foreground">{task.runtime}</span>}
      <span className="text-muted-foreground">{statusView(task?.status).label}</span>
      {total !== undefined && <span className="tabular-nums text-muted-foreground">{formatTokenCount(total)} tokens</span>}
      <span className="flex-1" />
      <Button
        variant="ghost"
        size="xs"
        onClick={() => { if (action.taskRunId !== undefined) void shell.openTaskTranscript(action.taskRunId, action.title); }}
      >
        <ExternalLink />
        查看任务对话
      </Button>
      {action.status === 'running' && (
        <Button variant="ghost" size="xs" className="text-destructive" disabled={cancelling} onClick={cancel}>
          {cancelling ? <Spinner /> : <Square />}
          取消任务
        </Button>
      )}
    </div>
  );
}

/** Collapsible action result: a truncated first line until expanded. */
function ResultBlock({ result }: { result: string }) {
  const [open, setOpen] = useState(false);
  const firstLine = (result.split('\n', 1)[0] ?? '').trim();
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        结果
      </button>
      {open
        ? <AppMarkdown className="text-sm">{result}</AppMarkdown>
        : <p className="truncate pl-5 text-xs text-muted-foreground">{firstLine}</p>}
    </div>
  );
}

export interface ActionCardProps {
  /** The action to render. */
  action: ActionModel;
  /** Auxiliary calls this action ran. */
  calls: readonly CallModel[];
  /** Ledger session id, forwarded to attachment media. */
  sessionId?: string;
  /** Cancel one dispatched task run; rejects when the daemon refuses. */
  onCancelTask: (taskRunId: string) => Promise<void>;
}

/** One action as an inline transcript card. */
export function ActionCard({ action, calls, sessionId, onCancelTask }: ActionCardProps) {
  const running = action.status === 'running';
  const Icon = ACTION_ICON[action.kind];
  const files = (action.files ?? []).map(fromSessionFile);
  return (
    <ToolCard
      icon={<Icon />}
      label={action.title}
      detail={action.subtitle}
      meta={<Elapsed start={action.startedAt} end={action.endedAt} />}
      status={running ? <Spinner className="size-3" /> : <StatusBadge tone={statusView(action.status).tone} label={statusView(action.status).label} />}
      running={running}
      defaultOpen={running}
    >
      {calls.map((call) => <CallRow key={call.id} call={call} />)}
      {action.outputs.length > 0 && <ContextItems items={action.outputs} />}
      {action.taskRunId !== undefined && <TaskRow action={action} onCancelTask={onCancelTask} />}
      {action.writes.length > 0 && (
        <div className="flex flex-col gap-1">
          {action.writes.map((write, index) => (
            <div key={`${write.path}:${index}`} className="flex items-center gap-2 text-xs text-muted-foreground">
              <FilePenLine className="size-3.5 shrink-0" />
              <span className="truncate font-mono">{write.path}</span>
              <span className="shrink-0">· {write.change}</span>
            </div>
          ))}
        </div>
      )}
      {files.length > 0 && <MediaAttachments items={files} sessionId={sessionId} />}
      {action.result !== undefined && action.result !== '' && <ResultBlock result={action.result} />}
    </ToolCard>
  );
}
