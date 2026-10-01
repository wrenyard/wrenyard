import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QueryError } from '@/renderer/components/query-error';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent, CardDescription } from '@/renderer/components/ui/card';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { Separator } from '@/renderer/components/ui/separator';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { StatusBadge } from '@/renderer/components/status-badge';
import { useConfirm } from '@/renderer/hooks/use-confirm';
import { shell } from '@/renderer/lib/desktop';
import {
  DAEMON_LABEL,
  DAEMON_RESTART_LABEL,
  DAEMON_STARTING_LABEL,
  DAEMON_START_LABEL,
  DAEMON_STATE_LABEL,
  ENDPOINT_DESCRIPTION,
  ENDPOINT_LABEL,
  SERVICE_CONNECTED_LABEL,
  SERVICE_LABEL,
  SERVICE_UNAVAILABLE_LABEL,
  WORKSPACE_DESCRIPTION,
  WORKSPACE_LABEL,
  WORKSPACE_MODE_LABEL,
  workspaceSaveLabel,
} from '../model/describe.js';
import {
  WORKSPACE_MODE_OPTIONS,
  daemonActionPending,
  daemonActionVisible,
  daemonLifecycleAction,
  daemonLifecycleDescription,
  daemonStateTone,
  errorMessage,
  isWorkspaceReadOnly,
  serviceDescription,
  serviceTone,
  workspaceDraftFromSnapshot,
  workspaceModeHint,
  workspaceNote,
  type DaemonLifecycleAction,
  type WorkspaceDraft,
} from '../model/settings.js';
import { daemonQueryKey, settingsQueryKey, useDaemonQuery, useSettingsQuery } from '../queries.js';

/** Local service, daemon lifecycle and the fixed workspace binding. */
export function RuntimeSettings() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const settings = useSettingsQuery();
  const daemon = useDaemonQuery();
  const service = settings.data?.service;
  const workspace = service?.workspace;

  const [draft, setDraft] = useState<WorkspaceDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  const [daemonError, setDaemonError] = useState('');

  // A fresh snapshot fills the form only while the user has no unsaved edits.
  useEffect(() => {
    if (workspace && !dirty) {
      setDraft(workspaceDraftFromSnapshot(workspace));
    }
  }, [workspace, dirty]);

  const daemonMutation = useMutation({
    mutationFn: (action: DaemonLifecycleAction) => (
      action === 'restart' ? shell.restartDaemon() : shell.startDaemon()
    ),
    onMutate: () => setDaemonError(''),
    onSuccess: (snapshot) => queryClient.setQueryData(daemonQueryKey, snapshot),
    onError: (error) => setDaemonError(errorMessage(error) || 'Daemon 操作失败，请稍后重试。'),
  });

  const workspaceMutation = useMutation({
    mutationFn: (next: WorkspaceDraft) => shell.saveWorkspace(next.path, next.create),
    onSuccess: () => {
      setDirty(false);
      setNote('Workspace 已保存，会话后端已切换，无需重启 App。');
      void queryClient.invalidateQueries({ queryKey: settingsQueryKey });
    },
    onError: (error) => setNote(errorMessage(error)),
  });

  const daemonAction = daemon.data ? daemonLifecycleAction(daemon.data) : null;
  const daemonStarting = daemon.data !== undefined && daemon.data.state === 'starting' && daemon.data.canStart;
  const daemonPending = daemon.data !== undefined && daemonActionPending(daemon.data, daemonMutation.isPending);

  const readOnly = workspace !== undefined && isWorkspaceReadOnly(workspace);

  // Restarting the daemon briefly drops the local service, so it is confirmed
  // through the shared ConfirmHost; starting an absent daemon is not.
  const onDaemonAction = (): void => {
    if (daemonAction === null) return;
    if (daemonAction === 'restart') {
      void confirm({
        title: '重启 Daemon？',
        description: '本地服务会短暂断开，正在运行的操作可能中断。',
        confirmLabel: '重启 Daemon',
        destructive: true,
      }).then((confirmed) => {
        if (confirmed) daemonMutation.mutate('restart');
      });
      return;
    }
    daemonMutation.mutate(daemonAction);
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <span>{SERVICE_LABEL}</span>
            {settings.isPending || service === undefined
              ? <Skeleton className="h-4 w-44" />
              : <CardDescription>{serviceDescription(service)}</CardDescription>}
          </div>
          {settings.isPending || service === undefined
            ? <Skeleton className="h-5 w-16" />
            : (
              <StatusBadge
                tone={serviceTone(service.status)}
                label={service.status === 'connected' ? SERVICE_CONNECTED_LABEL : SERVICE_UNAVAILABLE_LABEL}
              />
            )}
        </div>

        <Separator />

        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <span>{DAEMON_LABEL}</span>
            {daemon.isPending || daemon.data === undefined
              ? <Skeleton className="h-4 w-52" />
              : <p className="text-muted-foreground">{daemonLifecycleDescription(daemon.data)}</p>}
            {daemonError !== '' && <span className="text-destructive" role="alert">{daemonError}</span>}
          </div>
          <div className="flex items-center gap-2">
            {daemon.data === undefined
              ? <Skeleton className="h-5 w-16" />
              : <StatusBadge tone={daemonStateTone(daemon.data.state)} label={DAEMON_STATE_LABEL[daemon.data.state]} />}
            {daemon.data !== undefined && daemonActionVisible(daemon.data) && (
              <Button
                variant="outline"
               
                disabled={daemonPending}
                onClick={onDaemonAction}
              >
                {daemonStarting ? DAEMON_STARTING_LABEL : daemonAction === 'restart' ? DAEMON_RESTART_LABEL : DAEMON_START_LABEL}
              </Button>
            )}
          </div>
        </div>

        <Separator />

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <span>{WORKSPACE_LABEL}</span>
            <p className="text-muted-foreground">{WORKSPACE_DESCRIPTION}</p>
          </div>
          {workspace === undefined || draft === null ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Input
                  value={draft.path}
                  readOnly={readOnly}
                  spellCheck={false}
                  placeholder="/path/to/wrenyard-workspace"
                  aria-label={WORKSPACE_LABEL}
                  onChange={(event) => {
                    setDirty(true);
                    setNote('');
                    setDraft({ ...draft, path: event.target.value });
                  }}
                />
                <Select
                  value={draft.create ? 'create' : 'existing'}
                  onValueChange={(value) => {
                    setDirty(true);
                    setNote('');
                    setDraft({ ...draft, create: value === 'create' });
                  }}
                >
                  <SelectTrigger aria-label={WORKSPACE_MODE_LABEL} disabled={readOnly}>
                    <SelectValue>
                      {(value) => WORKSPACE_MODE_OPTIONS.find((option) => option.value === value)?.label ?? value}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {WORKSPACE_MODE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant={readOnly ? 'outline' : 'default'}
                  disabled={readOnly || workspaceMutation.isPending}
                  onClick={() => workspaceMutation.mutate(draft)}
                >
                  {workspaceSaveLabel(workspace, workspaceMutation.isPending)}
                </Button>
              </div>
              <p className="text-muted-foreground">{workspaceModeHint(draft.create)}</p>
              <p className="text-muted-foreground">{workspaceNote(workspace)}</p>
              {note !== '' && <p className="text-muted-foreground" role="status">{note}</p>}
            </>
          )}
        </div>

        <Separator />

        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <span>{ENDPOINT_LABEL}</span>
            <CardDescription>{ENDPOINT_DESCRIPTION}</CardDescription>
          </div>
          {service === undefined
            ? <Skeleton className="h-4 w-40" />
            : <code>{service.endpoint}</code>}
        </div>

        {settings.isError && <QueryError query={settings} title="读取失败" />}
      </CardContent>
    </Card>
  );
}
