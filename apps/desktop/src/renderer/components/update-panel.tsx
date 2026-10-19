import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, AlertDescription } from '@/renderer/components/ui/alert';
import { Button } from '@/renderer/components/ui/button';
import { CardDescription } from '@/renderer/components/ui/card';
import { Progress } from '@/renderer/components/ui/progress';
import { Separator } from '@/renderer/components/ui/separator';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { QueryError } from '@/renderer/components/query-error';
import { StatusBadge } from '@/renderer/components/status-badge';
import { shell } from '@/renderer/lib/desktop';
import { updateQuery } from '@/renderer/lib/queries';
import type { UpdateSnapshot } from '@/shell-contract';
import {
  UPDATE_AUTO_LABEL,
  UPDATE_CURRENT_VERSION_HINT,
  UPDATE_CURRENT_VERSION_LABEL,
  UPDATE_FOOTNOTE,
  formatUpdateCheckTime,
  updateView,
} from '@/renderer/lib/update';

function failureText(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return String(error);
}

export interface UpdatePanelProps {
  /**
   * False while the surface is not shown. A false→true transition (a reopen)
   * performs a fresh check, so a reopened surface never installs a candidate
   * recorded by an earlier check.
   */
  active?: boolean;
}

/**
 * Shared update surface. One check/install mutation drives the single action
 * button, and every state keeps that button truthful and disabled while a
 * request is already in flight. Bare content so the Settings card and the
 * update dialog can each supply their own chrome.
 */
export function UpdatePanel({ active = true }: UpdatePanelProps = {}) {
  const queryClient = useQueryClient();
  const update = useQuery(updateQuery);

  const action = useMutation({
    mutationFn: (mode: 'check' | 'install') => (mode === 'install' ? shell.requestInstall() : shell.checkUpdate()),
    onSuccess: (snapshot) => queryClient.setQueryData(updateQuery.queryKey, snapshot),
  });

  // Opening the surface re-checks the feed; the panel stays in its own
  // checking state from the first render until that check settles, so a stale
  // "install" button is never offered for a candidate an older check recorded.
  const [openCheckPending, setOpenCheckPending] = useState(active);
  const { mutate } = action;
  const checkedRef = useRef(false);
  useEffect(() => {
    if (!active) {
      checkedRef.current = false;
      return;
    }
    if (checkedRef.current) return;
    checkedRef.current = true;
    setOpenCheckPending(true);
    mutate('check', { onSettled: () => setOpenCheckPending(false) });
  }, [active, mutate]);

  const snapshot = update.data;
  const busy = update.isPending || action.isPending || openCheckPending;
  // A deliberate wait/install is still reported as itself, never as checking.
  const opening = openCheckPending
    && snapshot !== undefined
    && snapshot.state !== 'waiting'
    && snapshot.state !== 'installing';
  const shown: UpdateSnapshot | undefined = opening && snapshot !== undefined
    ? { ...snapshot, state: 'checking' }
    : snapshot;
  const view = updateView(shown, busy);
  // Structured progress comes from the shared update query; no local copy.
  const progress = shown?.state === 'installing' ? shown.progress : undefined;
  const downloadPercent = progress?.phase === 'downloading' ? progress.percent : undefined;
  const installable = shown !== undefined
    && shown.installSupported
    && (shown.state === 'available' || shown.state === 'waiting');

  const runAction = (): void => {
    action.mutate(installable ? 'install' : 'check');
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span>{UPDATE_CURRENT_VERSION_LABEL}</span>
          <CardDescription>{UPDATE_CURRENT_VERSION_HINT}</CardDescription>
        </div>
        {snapshot === undefined
          ? <Skeleton className="h-4 w-16" />
          : <span className="tabular-nums">{`v${snapshot.currentVersion}`}</span>}
      </div>

      <Separator />

      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span>{UPDATE_AUTO_LABEL}</span>
          {snapshot === undefined
            ? <Skeleton className="h-4 w-56" />
            : <p className="text-muted-foreground">{view.description}</p>}
          <span className="text-muted-foreground">
            {formatUpdateCheckTime(snapshot?.checkedAt)}
          </span>
        </div>
        {snapshot === undefined
          ? <Skeleton className="h-5 w-20" />
          : <StatusBadge tone={view.tone} label={view.label} />}
      </div>

      {progress !== undefined && (
        <Progress
          className="w-full"
          value={downloadPercent ?? null}
          aria-label={view.description}
        />
      )}

      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">{UPDATE_FOOTNOTE}</span>
        <div className="flex items-center gap-3">
          {snapshot?.installWarning !== undefined && snapshot.installWarning !== '' && (
            <span className="text-sm">{snapshot.installWarning}</span>
          )}
          <Button
            variant={view.primary ? 'default' : 'outline'}
            disabled={view.disabled}
            onClick={runAction}
          >
            {view.action}
          </Button>
        </div>
      </div>

      {update.isError && <QueryError query={update} title="暂时无法读取更新状态" />}

      {action.error != null && (
        <Alert variant="destructive">
          <AlertDescription>{`暂时无法启动更新：${failureText(action.error)}`}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
