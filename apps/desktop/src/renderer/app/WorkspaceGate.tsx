import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/renderer/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/renderer/components/ui/card';
import { Input } from '@/renderer/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/renderer/components/ui/select';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { shell } from '@/renderer/lib/desktop';
import { daemonQuery, settingsQuery, settingsQueryKey } from '@/renderer/lib/queries';
import {
  WORKSPACE_MODE_OPTIONS,
  errorMessage,
  isWorkspaceReadOnly,
  workspaceModeHint,
  workspaceNote,
} from '@/renderer/pages/settings/model/settings';
import type { SettingsSnapshot, WorkspaceConfigurationSnapshot } from '@/shell-contract';

type WorkspaceMode = 'create' | 'existing';

/** Onboarding copy for a workspace that is not yet usable. */
const GATE_HEADING = '先为工坊安一个家';
const PENDING_MESSAGE = '正在创建工作区并应用配置，请稍候…';

function GateShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
      {children}
    </div>
  );
}

/** Shown while the settings snapshot is still loading; children never mount. */
function GateLoading() {
  return (
    <GateShell>
      <div className="flex w-full max-w-md flex-col gap-3" aria-busy="true">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-32" />
      </div>
    </GateShell>
  );
}

/** Shown when the shared settings snapshot cannot be read; children never mount. */
function GateReadError({ error, retrying, onRetry }: { error: unknown; retrying: boolean; onRetry: () => void }) {
  return (
    <GateShell>
      <div className="flex w-full max-w-md flex-col gap-3">
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(error) || '读取工作区配置失败。'}
        </p>
        <div>
          <Button variant="outline" disabled={retrying} onClick={onRetry}>
            重试
          </Button>
        </div>
      </div>
    </GateShell>
  );
}

/** Onboarding card for a workspace that is missing or invalid. */
function WorkspaceOnboarding({ workspace }: { workspace: WorkspaceConfigurationSnapshot }) {
  const queryClient = useQueryClient();
  const readOnly = isWorkspaceReadOnly(workspace);
  const [path, setPath] = useState(workspace.path ?? '');
  const [mode, setMode] = useState<WorkspaceMode>(workspace.status === 'invalid' ? 'existing' : 'create');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const trimmedPath = path.trim();
  const submitDisabled = readOnly || pending || trimmedPath === '';

  const submit = (): void => {
    if (submitDisabled) return;
    setPending(true);
    setError('');
    // The input value is intentionally kept on failure so the user can retry.
    void shell
      .saveWorkspace(trimmedPath, mode === 'create')
      .then((saved) => {
        queryClient.setQueryData<SettingsSnapshot>(settingsQueryKey, (current) =>
          current === undefined
            ? current
            : { ...current, service: { ...current.service, workspace: saved } },
        );
        void queryClient.invalidateQueries({ queryKey: settingsQueryKey });
        void queryClient.invalidateQueries({ queryKey: daemonQuery.queryKey });
        // The gate only unblocks on a configured snapshot; anything else stays
        // visible instead of pretending activation succeeded.
        if (saved.status !== 'configured') {
          setError(`工作区仍未就绪：${workspaceNote(saved)}`);
        }
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause) || '保存工作区失败，请重试。');
      })
      .finally(() => {
        setPending(false);
      });
  };

  return (
    <GateShell>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{GATE_HEADING}</CardTitle>
          <CardDescription>{workspaceNote(workspace)}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            disabled={readOnly || pending}
            readOnly={readOnly}
            spellCheck={false}
            placeholder="/path/to/wrenyard-workspace"
            aria-label="工作区路径"
          />
          <Select
            value={mode}
            onValueChange={(value) => setMode(value as WorkspaceMode)}
            disabled={readOnly || pending}
          >
            <SelectTrigger className="w-full" aria-label="工作区模式">
              <SelectValue>
                {(value) => WORKSPACE_MODE_OPTIONS.find((option) => option.value === value)?.label ?? ''}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {WORKSPACE_MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">{workspaceModeHint(mode === 'create')}</p>
          {pending && <p className="text-sm text-muted-foreground">{PENDING_MESSAGE}</p>}
          {error !== '' && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="justify-end">
          <Button disabled={submitDisabled} onClick={submit}>
            {pending ? '正在应用…' : readOnly ? '环境变量管理' : '保存并应用'}
          </Button>
        </CardFooter>
      </Card>
    </GateShell>
  );
}

/**
 * Gate around the session page. It reads the shared settings snapshot and only
 * renders its children once the workspace is configured; while the snapshot
 * loads or fails it shows a loading/error state and never mounts the session.
 */
export function WorkspaceGate({ children }: { children: ReactNode }) {
  const settings = useQuery(settingsQuery);

  if (settings.isPending) return <GateLoading />;
  if (settings.isError) {
    return (
      <GateReadError
        error={settings.error}
        retrying={settings.isFetching}
        onRetry={() => { void settings.refetch(); }}
      />
    );
  }

  const workspace = settings.data?.service.workspace;
  if (workspace === undefined) return <GateLoading />;
  if (workspace.status === 'configured') return <>{children}</>;
  return <WorkspaceOnboarding workspace={workspace} />;
}
