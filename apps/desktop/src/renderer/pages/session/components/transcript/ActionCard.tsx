/**
 * One action of a turn as an expandable transcript step: its nested auxiliary
 * calls, loaded context, the dispatched task with its transcript and cancel
 * controls, its writes, the files it produced, and its result.
 */
import { useState } from 'react';
import { ExternalLink, FilePenLine, ListTodo, Square } from 'lucide-react';
import { AppMarkdown } from '@/renderer/components/app-markdown';
import { Elapsed } from '@/renderer/components/elapsed';
import { Button } from '@/renderer/components/ui/button';
import { Spinner } from '@/renderer/components/ui/spinner';
import { shell } from '@/renderer/lib/desktop';
import { formatTokenCount } from '@/renderer/lib/format';
import { statusView } from '../../model/describe.js';
import type { ActionModel, CallModel } from '../../model/types.js';
import { MediaAttachments, fromSessionFile } from '../MediaAttachments.js';
import { ActivityRow, ActivityRowStatus } from './ActivityRow.js';
import { NestedCallRow } from './CallRow.js';
import { ContextItems } from './ToolCard.js';

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

export interface ActionRowProps {
  /** The action to render. */
  action: ActionModel;
  /** Auxiliary calls this action ran. */
  calls: readonly CallModel[];
  /** Ledger session id, forwarded to attachment media. */
  sessionId?: string;
  /** Cancel one dispatched task run; rejects when the daemon refuses. */
  onCancelTask: (taskRunId: string) => Promise<void>;
}

/** One action as an expandable transcript step. */
export function ActionRow({ action, calls, sessionId, onCancelTask }: ActionRowProps) {
  const files = (action.files ?? []).map(fromSessionFile);
  return (
    <ActivityRow
      verb="操作"
      subject={action.title}
      meta={<Elapsed start={action.startedAt} end={action.endedAt} />}
      status={(
        <ActivityRowStatus
          running={action.status === 'running'}
          failed={action.status === 'failed'}
          cancelled={action.status === 'cancelled' || action.status === 'aborted'}
        />
      )}
    >
      {action.subtitle !== undefined && (
        <p className="text-xs text-muted-foreground">{action.subtitle}</p>
      )}
      {calls.length > 0 && (
        <div className="flex flex-col divide-y divide-border/60 rounded-lg border">
          {calls.map((call) => <NestedCallRow key={call.id} call={call} />)}
        </div>
      )}
      <ContextItems items={action.outputs} />
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
      {action.result !== undefined && action.result !== '' && (
        <div className="max-h-80 overflow-auto rounded-lg border bg-background/60 px-3 py-2 text-sm">
          <AppMarkdown className="text-sm">{action.result}</AppMarkdown>
        </div>
      )}
    </ActivityRow>
  );
}
