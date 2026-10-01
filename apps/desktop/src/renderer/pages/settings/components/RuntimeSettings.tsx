import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, FolderOpen } from 'lucide-react';
import { QueryError } from '@/renderer/components/query-error';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { StatusBadge } from '@/renderer/components/status-badge';
import { useConfirm } from '@/renderer/hooks/use-confirm';
import { copyText, shell } from '@/renderer/lib/desktop';
import {
  DAEMON_LABEL,
  DAEMON_RESTART_LABEL,
  DAEMON_STARTING_LABEL,
  DAEMON_START_LABEL,
  DAEMON_STATE_LABEL,
  RUNTIME_ENDPOINT_COPY_LABEL,
  RUNTIME_LOGS_DESCRIPTION,
  RUNTIME_LOGS_OPEN_LABEL,
  RUNTIME_SETTINGS_FILE_OPEN_LABEL,
  SERVICE_CONNECTED_LABEL,
  SERVICE_UNAVAILABLE_LABEL,
  SESSION_WORKSPACE_REVEAL_LABEL,
  SESSION_WORKSPACE_UNAVAILABLE,
} from '../model/describe.js';
import {
  daemonActionPending,
  daemonActionVisible,
  daemonLifecycleAction,
  daemonLifecycleDescription,
  daemonStateTone,
  errorMessage,
  serviceDescription,
  serviceTone,
  workspaceNote,
  type DaemonLifecycleAction,
} from '../model/settings.js';
import { daemonQueryKey, useDaemonQuery, useSettingsQuery } from '../queries.js';

/** Local service connection state. */
export function ServiceControl() {
  const settings = useSettingsQuery();
  const service = settings.data?.service;
  if (settings.isPending || service === undefined) return <Skeleton className="h-5 w-28" />;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted-foreground">{serviceDescription(service)}</span>
      <div>
        <StatusBadge
          tone={serviceTone(service.status)}
          label={service.status === 'connected' ? SERVICE_CONNECTED_LABEL : SERVICE_UNAVAILABLE_LABEL}
        />
      </div>
    </div>
  );
}

/** Local Daemon lifecycle with its launch/restart action. */
export function DaemonControl() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const daemon = useDaemonQuery();
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: (action: DaemonLifecycleAction) => (
      action === 'restart' ? shell.restartDaemon() : shell.startDaemon()
    ),
    onMutate: () => setError(''),
    onSuccess: (snapshot) => queryClient.setQueryData(daemonQueryKey, snapshot),
    onError: (cause) => setError(errorMessage(cause) || 'Daemon 操作失败，请稍后重试。'),
  });

  if (daemon.isPending || daemon.data === undefined) return <Skeleton className="h-5 w-52" />;

  const action = daemonLifecycleAction(daemon.data);
  const starting = daemon.data.state === 'starting' && daemon.data.canStart;
  const pending = daemonActionPending(daemon.data, mutation.isPending);

  const run = (): void => {
    if (action === null) return;
    if (action === 'restart') {
      void confirm({
        title: '重启 Daemon？',
        description: '本地服务会短暂断开，正在运行的操作可能中断。',
        confirmLabel: '重启 Daemon',
        destructive: true,
      }).then((confirmed) => { if (confirmed) mutation.mutate('restart'); });
      return;
    }
    mutation.mutate(action);
  };

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted-foreground">{daemonLifecycleDescription(daemon.data)}</span>
      {error !== '' && <span className="text-destructive" role="alert">{error}</span>}
      <div className="flex items-center gap-2">
        <StatusBadge tone={daemonStateTone(daemon.data.state)} label={DAEMON_STATE_LABEL[daemon.data.state]} />
        {daemonActionVisible(daemon.data) && (
          <Button variant="outline" disabled={pending} onClick={run}>
            {starting ? DAEMON_STARTING_LABEL : action === 'restart' ? DAEMON_RESTART_LABEL : DAEMON_START_LABEL}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Fixed workspace binding: read-only path plus a reveal action. */
export function WorkspaceControl() {
  const settings = useSettingsQuery();
  const workspace = settings.data?.service.workspace;
  if (settings.isPending || workspace === undefined) return <Skeleton className="h-8 w-full max-w-80" />;
  const path = workspace.path ?? '';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Input
          value={path}
          readOnly
          spellCheck={false}
          placeholder="/path/to/wrenyard-workspace"
          aria-label="工作区路径"
          className="max-w-80"
        />
        <Button
          variant="outline"
          disabled={path === ''}
          onClick={() => { void shell.revealWorkspace(path); }}
        >
          <FolderOpen />
          {SESSION_WORKSPACE_REVEAL_LABEL}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{path === '' ? SESSION_WORKSPACE_UNAVAILABLE : workspaceNote(workspace)}</p>
    </div>
  );
}

/** Read-only shared IPC endpoint path with copy. */
export function EndpointControl() {
  const settings = useSettingsQuery();
  const service = settings.data?.service;
  if (settings.isPending || service === undefined) return <Skeleton className="h-5 w-40" />;
  return (
    <div className="flex items-center gap-2">
      <code className="text-sm">{service.endpoint}</code>
      <Button variant="outline" onClick={() => { void copyText(service.endpoint); }}>
        <Copy />
        {RUNTIME_ENDPOINT_COPY_LABEL}
      </Button>
    </div>
  );
}

/** Opens the Wrenyard state logs directory. */
export function LogsControl() {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm text-muted-foreground">{RUNTIME_LOGS_DESCRIPTION}</span>
      <div>
        <Button variant="outline" onClick={() => { void shell.openLogsDirectory(); }}>
          <FolderOpen />
          {RUNTIME_LOGS_OPEN_LABEL}
        </Button>
      </div>
    </div>
  );
}

/** Opens the Desktop settings file with the OS default editor. */
export function SettingsFileControl() {
  return (
    <Button variant="outline" onClick={() => { void shell.openSettingsFile(); }}>
      <FolderOpen />
      {RUNTIME_SETTINGS_FILE_OPEN_LABEL}
    </Button>
  );
}

/** Unused marker kept so the settings query error surfaces once on the page. */
export function RuntimeQueryError() {
  const settings = useSettingsQuery();
  if (!settings.isError) return null;
  return <QueryError query={settings} title="读取失败" />;
}
