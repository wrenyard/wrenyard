import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Page, PageActions, PageContent, PageHeader, PageTitle } from '@/renderer/components/page';
import { QueryError } from '@/renderer/components/query-error';
import { Button } from '@/renderer/components/ui/button';
import { Empty, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import { registerPageCommands } from '@/renderer/lib/commands';
import { shell } from '@/renderer/lib/desktop';
import type { TaskSettingsPatch } from '@/shell-contract';
import { TaskDetail } from './components/TaskDetail.js';
import { TaskTree } from './components/TaskTree.js';
import * as copy from './model/describe.js';
import { buildTaskTree, tasksErrorMessage } from './model/settings.js';
import { useSaveTaskSettingsMutation, useTaskDetailQuery, useTaskSettingsQuery } from './queries.js';

interface TasksOpenArgs {
  taskRunId?: string;
  taskId?: string;
  project?: string;
}

/**
 * Parse the `tasks.open` argument. A bare string is the legacy run id; an
 * object may carry a run id plus the task definition identity/project used to
 * select the matching row. Unknown or empty values are ignored.
 */
function parseTasksOpenArgs(args: unknown): TasksOpenArgs | null {
  if (typeof args === 'string') return args.length > 0 ? { taskRunId: args } : null;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  const record = args as { taskRunId?: unknown; taskId?: unknown; project?: unknown };
  const parsed: TasksOpenArgs = {};
  if (typeof record.taskRunId === 'string' && record.taskRunId.length > 0) parsed.taskRunId = record.taskRunId;
  if (typeof record.taskId === 'string' && record.taskId.length > 0) parsed.taskId = record.taskId;
  if (typeof record.project === 'string' && record.project.length > 0) parsed.project = record.project;
  return Object.keys(parsed).length > 0 ? parsed : null;
}

/** The Task Settings page: directory tree beside the selected task's settings. */
export function TasksPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState<{ taskId?: string; project?: string } | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState('');
  const [successNote, setSuccessNote] = useState('');
  const [reseedNonce, setReseedNonce] = useState(0);

  const list = useTaskSettingsQuery();
  const rows = list.data?.rows ?? [];

  // `tasks.open` lands here after the command router navigates. The current
  // page lists task definitions rather than runs, so a run id opens that run's
  // shared transcript window; when the args name a task definition/project the
  // matching row is selected once the list loads. A bare request just shows the
  // page.
  useEffect(() => registerPageCommands('tasks', [{
    id: 'tasks.open',
    title: '打开任务',
    run: (args: unknown) => {
      const parsed = parseTasksOpenArgs(args);
      if (parsed === null) return;
      if (parsed.taskRunId !== undefined) void shell.openTaskTranscript(parsed.taskRunId);
      if (parsed.taskId !== undefined || parsed.project !== undefined) {
        setPendingOpen({
          ...(parsed.taskId !== undefined ? { taskId: parsed.taskId } : {}),
          ...(parsed.project !== undefined ? { project: parsed.project } : {}),
        });
      }
    },
  }]), []);

  // Apply a pending `tasks.open` selection once the definition list has loaded;
  // the command runs at mount, before the query resolves, so it cannot resolve
  // the row itself. An unmatched request still clears so it is not replayed.
  useEffect(() => {
    if (pendingOpen === null || rows.length === 0) return;
    const { taskId, project } = pendingOpen;
    const match = rows.find((row) => (
      (taskId === undefined || row.identity === taskId || row.name === taskId)
      && (project === undefined || row.project === project)
    ));
    if (match !== undefined) setSelectedId(match.identity);
    setPendingOpen(null);
  }, [pendingOpen, rows]);

  // Keep a valid selection: fall back to the first row when nothing valid is chosen.
  const selectedIdentity = useMemo(() => {
    if (selectedId !== null && rows.some((row) => row.identity === selectedId)) return selectedId;
    return rows[0]?.identity ?? null;
  }, [rows, selectedId]);

  const listRow = useMemo(
    () => rows.find((row) => row.identity === selectedIdentity) ?? null,
    [rows, selectedIdentity],
  );

  const detail = useTaskDetailQuery(listRow?.project, selectedIdentity);
  const row = useMemo(
    () => detail.data?.rows.find((candidate) => candidate.identity === selectedIdentity) ?? listRow,
    [detail.data, listRow, selectedIdentity],
  );

  const save = useSaveTaskSettingsMutation();
  const tree = useMemo(() => buildTaskTree(list.data), [list.data]);
  const aliases = detail.data?.aliases ?? list.data?.aliases ?? [];
  const revision = detail.data?.revision ?? list.data?.revision ?? '';
  const busy = save.isPending;
  const requestFailed = list.isError && list.data === undefined;
  const listStaleError = list.isError && list.data !== undefined;
  const displayError = error;

  const toggleGroup = (key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const refresh = (): void => {
    setError('');
    void list.refetch();
    if (selectedIdentity !== null) void detail.refetch();
  };

  const commit = (patch: TaskSettingsPatch): void => {
    if (row === null || busy) return;
    setSuccessNote('');
    if (Object.keys(patch).length === 0) {
      setError(copy.ERR_NO_CHANGES);
      return;
    }
    setError('');
    save.mutate(
      {
        scope: 'task',
        task_id: row.identity,
        ...(row.project !== undefined ? { project: row.project } : {}),
        expected_revision: revision,
        patch,
      },
      {
        onSuccess: () => {
          setError('');
          setSuccessNote(copy.SUCCESS_NOTE);
          // Re-seed the draft from the freshly saved layer (applies to reset too).
          setReseedNonce((nonce) => nonce + 1);
        },
        onError: (cause) => {
          const message = tasksErrorMessage(cause);
          setError(`${copy.ERR_SAVE_PREFIX}${message}`);
          if (message.includes('冲突')) {
            // Keep the in-progress draft, refresh authoritative state, explain the conflict.
            setSuccessNote('');
            void Promise.all([list.refetch(), detail.refetch()]).then(() => setError(copy.ERR_SAVE_CONFLICT));
          }
        },
      },
    );
  };

  return (
      <Page data-page="tasks">
        <PageHeader>
          <PageTitle>{copy.PAGE_TITLE}</PageTitle>
          <PageActions>
            <Button variant="outline" disabled={list.isFetching} onClick={refresh}>
              <RefreshCw />
              {list.isFetching ? copy.REFRESH_BUSY_LABEL : copy.REFRESH_LABEL}
            </Button>
          </PageActions>
        </PageHeader>
        <PageContent fill>
          {requestFailed ? (
            <QueryError query={list} title={copy.DIRECTORY_LOAD_FAILED} />
          ) : (
            <>
              {listStaleError && <QueryError query={list} />}
              {detail.isError && <QueryError query={detail} />}
              <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] gap-4 @3xl/main:grid-cols-[clamp(170px,23vw,250px)_minmax(0,1fr)]">
                <TaskTree
                  model={tree}
                  loading={list.isPending}
                  selectedId={selectedIdentity}
                  collapsed={collapsed}
                  onToggleGroup={toggleGroup}
                  onSelect={setSelectedId}
                />
                {row !== null ? (
                  <TaskDetail
                    row={row}
                    fallbackAliases={aliases}
                    loading={selectedIdentity !== null && detail.isPending}
                    busy={busy}
                    reseedNonce={reseedNonce}
                    error={displayError}
                    successNote={successNote}
                    onCommit={commit}
                    onError={setError}
                    onClearError={() => setError('')}
                  />
                ) : (
                  <Empty>
                    <EmptyHeader>
                      <EmptyTitle>{copy.DETAIL_EMPTY}</EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                )}
              </div>
            </>
          )}
        </PageContent>
      </Page>
  );
}
