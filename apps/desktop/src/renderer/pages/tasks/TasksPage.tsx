import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Page, PageActions, PageContent, PageHeader, PageTitle } from '@/renderer/components/page';
import { Button } from '@/renderer/components/ui/button';
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';
import type { TaskSettingsPatch } from '@/shell-contract';
import { TaskDetail } from './components/TaskDetail.js';
import { TaskTree } from './components/TaskTree.js';
import * as copy from './model/describe.js';
import { buildTaskTree, tasksErrorMessage } from './model/settings.js';
import { useSaveTaskSettingsMutation, useTaskDetailQuery, useTaskSettingsQuery } from './queries.js';

/** The Task Settings page: directory tree beside the selected task's settings. */
export function TasksPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState('');
  const [successNote, setSuccessNote] = useState('');
  const [reseedNonce, setReseedNonce] = useState(0);

  const list = useTaskSettingsQuery();
  const rows = list.data?.rows ?? [];

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
  const listError = list.isError && list.data !== undefined
    ? `${copy.ERR_LOAD_PREFIX}${tasksErrorMessage(list.error)}`
    : '';
  const displayError = error !== '' ? error : listError;

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
        <PageContent className="min-h-0 overflow-hidden">
          {requestFailed ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{copy.DIRECTORY_LOAD_FAILED}</EmptyTitle>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={refresh}>{copy.RETRY_LABEL}</Button>
              </EmptyContent>
            </Empty>
          ) : (
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
          )}
        </PageContent>
      </Page>
  );
}
