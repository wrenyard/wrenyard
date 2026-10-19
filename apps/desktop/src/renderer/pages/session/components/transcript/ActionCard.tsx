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
import { ACTION_KIND_LABEL, statusView, stepName } from '../../model/describe.js';
import type { ActionModel, CallModel, ContextItem } from '../../model/types.js';
import { MediaAttachments, fromSessionFile } from '../MediaAttachments.js';
import { ActivityRow, ActivityRowStatus, OutputBox } from './ActivityRow.js';
import { CallMeta, NestedCallRow } from './CallRow.js';
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
  /** The turn's context items, for nested step naming. */
  contextItems?: readonly ContextItem[];
  /** Ledger session id, forwarded to attachment media. */
  sessionId?: string;
  /** Cancel one dispatched task run; rejects when the daemon refuses. */
  onCancelTask: (taskRunId: string) => Promise<void>;
}

/** Pretty-printed compiled task input, or the compile call's own output. */
function compiledInput(action: ActionModel, compile: CallModel | undefined): string {
  if (action.parsed !== undefined) return JSON.stringify(action.parsed, null, 2);
  return compile?.output ?? '';
}

/** A dispatch's input: the full prompt and the compiled task input, collapsed. */
function DispatchInput({ action, compile, contextItems }: { action: ActionModel; compile: CallModel | undefined; contextItems?: readonly ContextItem[] }) {
  const input = compiledInput(action, compile);
  const name = compile === undefined
    ? ''
    : stepName({ kind: 'call', call: compile }, { contextItems, actionTitle: () => action.title || undefined });
  return (
    <div className="rounded-lg border">
      <ActivityRow
        verb="派发输入"
        subject={name}
        meta={compile === undefined ? undefined : <Elapsed start={compile.startedAt} end={compile.endedAt} />}
        openMeta={compile === undefined ? undefined : <CallMeta call={compile} />}
        status={compile === undefined ? undefined : (
          <ActivityRowStatus
            running={compile.status === 'running'}
            failed={compile.status === 'failed'}
            cancelled={compile.status === 'aborted'}
          />
        )}
        compact
      >
        {action.prompt !== undefined && (
          <>
            <p className="text-xs text-muted-foreground">派发提示词</p>
            <OutputBox>{action.prompt}</OutputBox>
          </>
        )}
        {input !== '' && (
          <>
            <p className="text-xs text-muted-foreground">编译后的任务输入</p>
            <OutputBox>{input}</OutputBox>
          </>
        )}
        {compile?.error !== undefined && <p className="text-destructive">{compile.error}</p>}
      </ActivityRow>
    </div>
  );
}

/** One action as an expandable transcript step. */
export function ActionRow({ action, calls, contextItems, sessionId, onCancelTask }: ActionRowProps) {
  const files = (action.files ?? []).map(fromSessionFile);
  const dispatch = action.kind === 'dispatch';
  // A dispatch folds its compile call into the input block; other nested calls stay listed.
  const compile = dispatch ? calls.filter((call) => call.role === 'dispatch').at(-1) : undefined;
  const nested = compile === undefined ? calls : calls.filter((call) => call !== compile);
  // Nested calls name their parent action when it has one.
  const naming = { contextItems, actionTitle: () => action.title || undefined };
  const nameOf = (call: CallModel): string => stepName({ kind: 'call', call }, naming);
  return (
    <ActivityRow
      verb={ACTION_KIND_LABEL[action.kind]}
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
      {dispatch ? <DispatchInput action={action} compile={compile} contextItems={contextItems} /> : action.subtitle !== undefined && (
        <p className="text-xs text-muted-foreground">{action.subtitle}</p>
      )}
      {nested.length > 0 && (
        <div className="flex flex-col divide-y divide-border/60 rounded-lg border">
          {nested.map((call) => <NestedCallRow key={call.id} call={call} name={nameOf(call)} />)}
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
      {action.result !== undefined && action.result !== '' && (dispatch ? (
        // The task's answer reads like a reply, not like tool output.
        <AppMarkdown className="text-sm leading-relaxed">{action.result}</AppMarkdown>
      ) : (
        <div className="max-h-80 overflow-auto rounded-lg border bg-background/60 px-3 py-2 text-sm">
          <AppMarkdown className="text-sm">{action.result}</AppMarkdown>
        </div>
      ))}
    </ActivityRow>
  );
}
