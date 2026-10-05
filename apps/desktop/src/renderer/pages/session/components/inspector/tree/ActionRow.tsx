import { createContext, useContext } from 'react';
import { BookOpen, ChevronDown, ChevronRight, ExternalLink, FilePenLine, Send } from 'lucide-react';
import { AppMarkdown as Markdown } from '@/renderer/components/app-markdown';
import { Elapsed } from '@/renderer/components/elapsed';
import { StatusBadge, type StatusTone } from '@/renderer/components/status-badge';
import { Button } from '@/renderer/components/ui/button';
import { shell } from '@/renderer/lib/desktop';
import { actionLabel, statusView } from '../../../model/describe.js';
import type { ActionNode } from '../../../model/types.js';
import { useSessionUsage } from '../../../state/session-usage.js';
import { MediaAttachments, fromSessionFile } from '../../MediaAttachments.js';
import { EntryRow } from './EntryRow.js';
import { TREE_CHILDREN, actionAnchorId, actionNodeId, actionPartId } from './ids.js';
import { useTreeExpansion } from './expansion.js';

function KindIcon({ kind }: { kind: ActionNode['kind'] }) {
  if (kind === 'read') return <BookOpen className="size-3.5 shrink-0 text-muted-foreground" />;
  if (kind === 'write') return <FilePenLine className="size-3.5 shrink-0 text-muted-foreground" />;
  return <Send className="size-3.5 shrink-0 text-muted-foreground" />;
}

/** Run ids of dispatched tasks that are still waiting to launch. */
export const QueuedTaskRunsContext = createContext<ReadonlySet<string>>(new Set());

function actionStatus(action: ActionNode, queued: ReadonlySet<string>): { tone: StatusTone; label: string } {
  if (action.status === 'timeout') return { tone: 'warning', label: '超时' };
  // A dispatched task that has not launched yet is waiting, not working.
  if (action.status === 'running' && action.taskRunId !== undefined && queued.has(action.taskRunId)) {
    return { tone: 'warning', label: '排队中' };
  }
  return statusView(action.status);
}

function ResultBox({ actionId, text }: { actionId: string; text: string }) {
  const { isOpen, toggle } = useTreeExpansion();
  const nodeId = actionPartId(actionId, 'result');
  const open = isOpen(nodeId);
  const line = text.split('\n', 1)[0] ?? '';
  const summary = line.length > 120 ? `${line.slice(0, 120)}…` : line;
  return (
    <div className="flex flex-col gap-1">
      <button type="button" onClick={() => toggle(nodeId)} className="flex items-center gap-2 rounded-lg px-2 py-0.5 text-left hover:bg-muted/60">
        {open
          ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="shrink-0 text-xs text-muted-foreground">结果</span>
        {!open && <span className="min-w-0 flex-1 truncate">{summary}</span>}
      </button>
      {open && <div className={`${TREE_CHILDREN} px-2`}><Markdown>{text}</Markdown></div>}
    </div>
  );
}

function ActionBody({ action }: { action: ActionNode }) {
  const { sessionKey } = useSessionUsage();
  const transcriptId = action.taskRunId;
  return (
    <div className={`${TREE_CHILDREN} gap-2 py-1 pr-2 text-sm`}>
      {action.intent !== '' && <p className="px-2 whitespace-pre-wrap text-muted-foreground">{action.intent}</p>}
      {action.compile && (
        <EntryRow entry={action.compile} nodeId={actionPartId(action.id, 'compile')} />
      )}
      {(action.taskDisplayName !== undefined || action.project !== undefined || transcriptId !== undefined) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-xs text-muted-foreground">
          {action.taskDisplayName !== undefined && <span>{action.taskDisplayName}</span>}
          {action.project !== undefined && <span>项目 {action.project}</span>}
          {transcriptId !== undefined && (
            <span className="flex items-center gap-2">
              运行 {transcriptId}
              <Button variant="outline" size="xs" onClick={() => { void shell.openTaskTranscript(transcriptId); }}>
                <ExternalLink /> 查看任务对话
              </Button>
            </span>
          )}
        </div>
      )}
      {action.entries.length > 0 && (
        <div className="flex flex-col">
          {action.entries.map((entry, index) => (
            <EntryRow key={`${entry.at}-${index}`} entry={entry} nodeId={actionPartId(action.id, `entry:${index}`)} />
          ))}
        </div>
      )}
      {action.result !== undefined && action.result !== '' && (
        <ResultBox actionId={action.id} text={action.result} />
      )}
      {action.files.length > 0 && (
        <MediaAttachments items={action.files.map(fromSessionFile)} sessionId={sessionKey} />
      )}
      {action.errors.map((error, index) => (
        <p key={index} className="text-xs text-warning">{error}</p>
      ))}
    </div>
  );
}

export interface ActionRowProps {
  action: ActionNode;
}

/** One action of the 行动 phase, expandable in place. */
export function ActionRow({ action }: ActionRowProps) {
  const { isOpen, toggle } = useTreeExpansion();
  const nodeId = actionNodeId(action.id);
  const open = isOpen(nodeId);
  const status = actionStatus(action, useContext(QueuedTaskRunsContext));
  return (
    <div className="flex flex-col" id={actionAnchorId(action.id)}>
      <button
        type="button"
        onClick={() => toggle(nodeId)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors hover:bg-muted/60"
      >
        {open
          ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
        <KindIcon kind={action.kind} />
        <span className="min-w-0 flex-1 truncate">{actionLabel(action)}</span>
        <StatusBadge tone={status.tone} label={status.label} className="shrink-0" />
        <Elapsed start={action.startedAt} end={action.endedAt} className="shrink-0 text-xs text-muted-foreground" />
      </button>
      {open && <ActionBody action={action} />}
    </div>
  );
}
