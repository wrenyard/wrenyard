import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent, CardDescription } from '@/renderer/components/ui/card';
import { Separator } from '@/renderer/components/ui/separator';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { StatusBadge } from '@/renderer/components/status-badge';
import { checkUpdate, requestInstall } from '@/renderer/lib/desktop';
import {
  UPDATE_AUTO_LABEL,
  UPDATE_CURRENT_VERSION_HINT,
  UPDATE_CURRENT_VERSION_LABEL,
  UPDATE_FOOTNOTE,
  formatUpdateCheckTime,
  updateView,
} from '../model/describe.js';
import { updateQueryKey, useUpdateQuery } from '../queries.js';

/**
 * Update surface. Desktop only checks and prompts; the installed engine
 * performs the install. Every state keeps the single action button truthful
 * and disabled while an update request is already in flight.
 */
export function UpdateSettings() {
  const queryClient = useQueryClient();
  const update = useUpdateQuery();

  const action = useMutation({
    mutationFn: (mode: 'check' | 'install') => (mode === 'install' ? requestInstall() : checkUpdate()),
    onSuccess: (snapshot) => queryClient.setQueryData(updateQueryKey, snapshot),
  });

  const snapshot = update.data;
  const view = snapshot === undefined ? null : updateView(snapshot, action.isPending);
  const installable = snapshot !== undefined
    && snapshot.installSupported
    && (snapshot.state === 'available' || snapshot.state === 'waiting');
  const busy = snapshot !== undefined && (snapshot.state === 'checking' || snapshot.state === 'installing');

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
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
            {view === null
              ? <Skeleton className="h-4 w-56" />
              : <p className="text-muted-foreground">{view.description}</p>}
            <span className="text-muted-foreground">
              {formatUpdateCheckTime(snapshot?.checkedAt)}
            </span>
          </div>
          {view === null
            ? <Skeleton className="h-5 w-20" />
            : <StatusBadge tone={view.tone} label={view.label} />}
        </div>

        {busy && <Skeleton className="h-1 w-full" />}

        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">{UPDATE_FOOTNOTE}</span>
          <Button
            variant={view?.primary === true ? 'default' : 'outline'}
            disabled={view === null || view.disabled || update.isPending}
            onClick={() => action.mutate(installable ? 'install' : 'check')}
          >
            {view?.action ?? '检查更新'}
          </Button>
        </div>

        {update.isError && (
          <p className="text-destructive" role="alert">暂时无法读取更新状态，请重试。</p>
        )}
      </CardContent>
    </Card>
  );
}
