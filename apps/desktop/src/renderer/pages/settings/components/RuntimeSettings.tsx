import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, EyeOff, FolderOpen, RefreshCw } from 'lucide-react';
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
  isWorkspaceReadOnly,
  serviceDescription,
  serviceTone,
  workspaceNote,
  workspaceSwitchErrorMessage,
  WORKSPACE_SAVE_LABEL,
  WORKSPACE_SAVING_LABEL,
  WORKSPACE_SWITCHING_NOTE,
  type DaemonLifecycleAction,
} from '../model/settings.js';
import { daemonQueryKey, settingsQueryKey, useDaemonQuery, useSettingsQuery } from '../queries.js';
import type { SettingsSnapshot, WrenyardGatewayPortChoice, WrenyardGatewaySettings } from '@/shell-contract';

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

/**
 * Workspace binding: an editable path for a user-managed root plus a reveal
 * action. Saving applies the change through the daemon's idle-only
 * `workspace.switch` method — the daemon stays running — and a busy or invalid
 * switch shows the daemon's own reason instead of leaving a dead control. A root
 * pinned by WRENYARD_WORKSPACE stays read-only with its explanation.
 */
export function WorkspaceControl() {
  const queryClient = useQueryClient();
  const settings = useSettingsQuery();
  const workspace = settings.data?.service.workspace;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: (nextPath: string) => shell.saveWorkspace(nextPath, false),
    onMutate: () => setError(''),
    onSuccess: (saved) => {
      setDraft(null);
      queryClient.setQueryData<SettingsSnapshot>(settingsQueryKey, (current) => (
        current === undefined
          ? current
          : { ...current, service: { ...current.service, workspace: saved } }
      ));
      if (saved.status !== 'configured') setError(`工作区仍未就绪：${workspaceNote(saved)}`);
    },
    onError: (cause) => setError(workspaceSwitchErrorMessage(cause)),
  });

  if (settings.isPending || workspace === undefined) return <Skeleton className="h-8 w-full max-w-80" />;

  const path = workspace.path ?? '';
  const readOnly = isWorkspaceReadOnly(workspace);
  const value = draft ?? path;
  const pending = mutation.isPending;
  const canSave = !readOnly && !pending && value.trim() !== '' && value.trim() !== path;

  const save = (): void => {
    if (!canSave) return;
    mutation.mutate(value.trim());
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Input
          value={value}
          readOnly={readOnly}
          disabled={pending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
          spellCheck={false}
          placeholder="/path/to/wrenyard-workspace"
          aria-label="工作区路径"
          className="max-w-80"
        />
        {!readOnly && (
          <Button disabled={!canSave} onClick={save}>
            {pending ? WORKSPACE_SAVING_LABEL : WORKSPACE_SAVE_LABEL}
          </Button>
        )}
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
      {pending && <p className="text-sm text-muted-foreground">{WORKSPACE_SWITCHING_NOTE}</p>}
      {error !== '' && <p role="alert" className="text-sm text-destructive">{error}</p>}
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

/** Gateway settings use the daemon's bind-time snapshot; saves never rebind it. */
export function GatewayControl() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [portMode, setPortMode] = useState<'random' | 'fixed' | null>(null);
  const [portText, setPortText] = useState<string | undefined>(undefined);
  const [tokenText, setTokenText] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const query = useQuery({ queryKey: ['gateway-settings'], queryFn: () => shell.getGatewaySettings() });
  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof shell.saveGatewaySettings>[0]) => shell.saveGatewaySettings(input),
    onSuccess: (result) => {
      queryClient.setQueryData(['gateway-settings'], result);
      setPortMode(result.savedPortMode);
      setPortText(undefined);
      setTokenText('');
      setSaved('已保存；所有更改将在 Gateway 下次绑定时生效。');
      setError('');
    },
    onError: (cause) => { setSaved(''); setError(errorMessage(cause) || '保存 Gateway 设置失败。'); },
  });
  const data = query.data;
  if (query.isPending || data === undefined) return <Skeleton className="h-8 w-full" />;
  const mode = portMode ?? data.savedPortMode;
  const portDraft = portText ?? (data.savedPort === undefined ? '' : String(data.savedPort));
  const fixedPort = mode === 'fixed' ? Number(portDraft) : undefined;
  const portInvalid = mode === 'fixed' && (portDraft.trim() === '' || !Number.isInteger(fixedPort) || fixedPort! < 1 || fixedPort! > 65535);
  const portChoice: WrenyardGatewayPortChoice = mode === 'random' ? { mode: 'random' } : { mode: 'fixed', port: fixedPort ?? 0 };
  const savePort = (): void => {
    if (portInvalid) { setSaved(''); setError('请输入 1–65535 之间的整数端口。'); return; }
    mutation.mutate({ port: portChoice });
  };
  const replaceToken = (replacement: { kind: 'custom'; token: string } | { kind: 'generate' }): void => {
    const description = '替换 Token 后，现有外部客户端必须更新凭据。新 Token 只会在 Gateway 下次绑定时生效。';
    void confirm({ title: '替换 Gateway Token？', description, confirmLabel: '确认替换', destructive: true })
      .then((accepted) => { if (accepted) mutation.mutate({ token: replacement, confirmTokenReplacement: true }); });
  };
  const effective = data.effective;
  const masked = '•'.repeat(Math.min(effective.token.length, 32));
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <strong>当前生效连接</strong>
        <p className="text-sm text-muted-foreground">仅监听本机 127.0.0.1。随机端口由操作系统在 Daemon 启动并绑定时分配。</p>
        <div className="grid gap-1 text-sm">
          <div>主机：<code>{effective.host}</code>　端口：<code>{effective.port}</code></div>
          <div>OpenAI Chat：<code>{effective.openaiChatBaseUrl}</code></div>
          <div>OpenAI Responses：<code>{effective.openaiResponsesBaseUrl}</code></div>
          <div>Anthropic：<code>{effective.anthropicBaseUrl}</code></div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <code>{showToken ? effective.token : masked}</code>
          <Button variant="outline" onClick={() => setShowToken((value) => !value)}>{showToken ? <EyeOff /> : <Eye />}{showToken ? '隐藏' : '显示 Token'}</Button>
          <Button variant="outline" onClick={() => { void copyText(effective.token); }}><Copy />复制当前 Token</Button>
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <strong>下次绑定使用的设置</strong>
        <p className="text-sm text-muted-foreground">保存不会重启或改变当前连接。端口和 Token 的更改都只在 Gateway 下次绑定时生效。</p>
        <div className="flex flex-wrap items-center gap-2">
          <select className="h-9 rounded-md border bg-background px-3 text-sm" value={mode} disabled={mutation.isPending} onChange={(event) => setPortMode(event.target.value as 'random' | 'fixed')}>
            <option value="random">随机端口</option><option value="fixed">固定端口</option>
          </select>
          {mode === 'fixed' && <Input className="w-32" inputMode="numeric" aria-label="固定端口" value={portDraft} onChange={(event) => { setPortText(event.target.value); setError(''); }} placeholder="1–65535" />}
          <Button disabled={mutation.isPending} onClick={savePort}>{mutation.isPending ? '保存中…' : '保存端口设置'}</Button>
        </div>
        {mode === 'fixed' && portInvalid && <p role="alert" className="text-sm text-destructive">请输入 1–65535 之间的整数端口。</p>}
        <p className="text-sm">已保存：{data.savedPortMode === 'fixed' ? `固定端口 ${data.savedPort ?? '无效'}` : '随机端口'}；当前生效端口：{effective.port}{data.portChangePending ? '（等待下次绑定）' : ''}</p>
        {data.tokenChangePending && <p className="text-sm">Token 替换等待下次绑定生效。</p>}
      </section>
      <section className="flex flex-col gap-2">
        <strong>替换 Token</strong>
        <div className="flex flex-wrap items-center gap-2">
          <Input className="max-w-80" type="password" autoComplete="new-password" value={tokenText} onChange={(event) => setTokenText(event.target.value)} placeholder="输入自定义 Token" />
          <Button variant="outline" disabled={mutation.isPending || tokenText.length === 0} onClick={() => replaceToken({ kind: 'custom', token: tokenText })}>保存自定义 Token</Button>
          <Button variant="outline" disabled={mutation.isPending} onClick={() => replaceToken({ kind: 'generate' })}><RefreshCw />生成新 Token</Button>
        </div>
        {saved !== '' && <p className="text-sm text-muted-foreground">{saved}</p>}
        {error !== '' && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </section>
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
