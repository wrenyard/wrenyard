import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { StatusBadge, type StatusTone } from '@/renderer/components/status-badge';
import { Button } from '@/renderer/components/ui/button';
import { Spinner } from '@/renderer/components/ui/spinner';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { clientAct, clientList } from '@/renderer/lib/desktop';
import type { ClientAction, ClientListEntry, ClientReadiness } from '@/shell-contract';
import { errorMessage } from '../model/settings.js';

const CLIENTS_UNAVAILABLE_TITLE = '客户端状态暂时不可用。';
const CLIENTS_REFRESH_LABEL = '重新检测';
const CLIENTS_CHECKING_LABEL = '检测中…';
const CLIENTS_SCOPE_NOTE =
  '列表由守护进程检测并上报；有 npm 安装源的客户端可在此直接安装或升级，其余请手动处理。';
const CLIENTS_POLL_MS = 1_000;

const READINESS_LABEL: Record<ClientReadiness, string> = {
  ready: '可用',
  not_installed: '未安装',
  disabled: '已停用',
  error: '异常',
};

const READINESS_TONE: Record<ClientReadiness, StatusTone> = {
  ready: 'success',
  not_installed: 'muted',
  disabled: 'warning',
  error: 'danger',
};

const BUSY_LABEL: Record<'install' | 'upgrade', string> = {
  install: '安装中…',
  upgrade: '升级中…',
};

type PendingAction = { action: ClientAction };

/**
 * 客户端 page: one row per supported agent client reported by the daemon's
 * `client.list` method — display name and version, a labelled status badge
 * (reason shown in a tooltip on non-ready states) and the detected executable
 * path. Clients with an npm install source expose install/upgrade actions that
 * the daemon runs as a background job; the list re-polls every second while any
 * install or upgrade is in flight. The 重新检测 button re-runs detection and
 * refresh checks for available upgrades.
 */
export function ClientsSettings() {
  const [clients, setClients] = useState<ClientListEntry[] | null>(null);
  const [host, setHost] = useState<{ hostname: string; platform: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Record<string, PendingAction>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const refresh = useCallback(async (checkUpdates: boolean) => {
    setLoading(true);
    try {
      const result = await clientList({ checkUpdates });
      setClients(result.clients);
      setHost(result.host);
      const byId = new Map(result.clients.map((client) => [client.id, client]));
      setPending((current) => Object.fromEntries(
        Object.entries(current).filter(([id, pendingAction]) => {
          const client = byId.get(id);
          if (client === undefined) return false;
          if (pendingAction.action === 'install') {
            return client.installed !== true && client.source === 'npm' && client.npmPackage !== undefined;
          }
          return client.installed === true && client.source === 'npm' &&
            (client.updateAvailable === true ||
              (client.updateAvailable === undefined && client.latestVersion === undefined));
        }),
      ));
      setRowErrors((current) => Object.fromEntries(
        Object.entries(current).filter(([id]) => {
          const client = byId.get(id);
          return client !== undefined && (
            (client.installed === true && client.source === 'npm') ||
            (client.installed !== true && client.source === 'npm' && client.npmPackage !== undefined)
          );
        }),
      ));
      setError('');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  const act = useCallback(async (entry: ClientListEntry, action: ClientAction) => {
    setPending((current) => {
      const next = { ...current };
      delete next[entry.id];
      return next;
    });
    setRowErrors((current) => {
      const next = { ...current };
      delete next[entry.id];
      return next;
    });
    try {
      const result = await clientAct(entry.id, action);
      setClients((current) =>
        current === null
          ? current
          : current.map((client) => (client.id === entry.id ? result.client : client)),
      );
    } catch (failure) {
      setRowErrors((current) => ({ ...current, [entry.id]: errorMessage(failure) }));
    }
  }, []);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  // Poll while any client has an install/upgrade in flight; the daemon clears
  // `busy` when the background job finishes.
  const anyBusy = (clients ?? []).some((client) => client.busy !== undefined);
  useEffect(() => {
    if (!anyBusy) return;
    const timer = setInterval(() => {
      void refresh(false);
    }, CLIENTS_POLL_MS);
    return () => clearInterval(timer);
  }, [anyBusy, refresh]);

  const requestAction = (entry: ClientListEntry, action: ClientAction): void => {
    setPending((current) => ({ ...current, [entry.id]: { action } }));
  };

  const sourceLabel = (entry: ClientListEntry): string =>
    entry.source === 'npm' ? 'npm' : entry.source === 'homebrew' ? 'Homebrew' : '手动';

  const canInstall = (entry: ClientListEntry): boolean =>
    !entry.installed && entry.source === 'npm' && entry.npmPackage !== undefined;

  const canUpgrade = (entry: ClientListEntry): boolean =>
    entry.installed && entry.source === 'npm' && entry.updateAvailable === true;

  const renderActions = (entry: ClientListEntry) => {
    if (entry.installed && entry.source !== 'npm') {
      return (
        <span className="shrink-0 text-xs text-muted-foreground">
          {entry.source === 'homebrew' ? '由 Homebrew 管理，请使用 Homebrew 升级。' : '请手动安装与升级'}
        </span>
      );
    }

    const confirm = pending[entry.id];
    if (confirm !== undefined) {
      const isUpgrade = confirm.action === 'upgrade';
      const detail = isUpgrade
        ? `将升级 ${entry.npmPackage} 至 ${entry.latestVersion ?? 'latest'}`
        : `将从 npm 全局安装 ${entry.npmPackage}@latest`;
      return (
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-xs text-muted-foreground">{detail}</span>
          <Button
            variant="default"
            size="sm"
            className="shrink-0"
            disabled={loading}
            onClick={() => { void act(entry, confirm.action); }}
          >
            确认
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            disabled={loading}
            onClick={() =>
              setPending((current) => {
                const next = { ...current };
                delete next[entry.id];
                return next;
              })
            }
          >
            取消
          </Button>
        </div>
      );
    }

    if (entry.busy !== undefined) {
      return (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          {BUSY_LABEL[entry.busy]}
        </span>
      );
    }

    if (entry.npmPackage === undefined || (entry.installed && entry.source !== 'npm')) {
      return <span className="shrink-0 text-xs text-muted-foreground">请手动安装与升级</span>;
    }

    return (
      <div className="flex shrink-0 items-center gap-2">
        {entry.installed && entry.source === 'npm' && entry.updateAvailable === true && (
          <span className="text-xs text-muted-foreground">
            可升级{entry.latestVersion !== undefined ? ` · ${entry.latestVersion}` : ''}
          </span>
        )}
        {canInstall(entry) && (
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => requestAction(entry, 'install')}
          >
            安装
          </Button>
        )}
        {canUpgrade(entry) && entry.lastError === undefined && (
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => requestAction(entry, 'upgrade')}
          >
            升级
          </Button>
        )}
        {entry.lastError !== undefined && (entry.installed ? entry.source === 'npm' : entry.npmPackage !== undefined) && (
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => requestAction(entry, entry.installed ? 'upgrade' : 'install')}
          >
            重试
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-sm text-muted-foreground">已支持客户端的运行环境状态</span>
          {host !== null && (
            <span className="text-xs text-muted-foreground">{host.hostname} · {host.platform}</span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={loading}
          onClick={() => { void refresh(true); }}
        >
          <RefreshCw />
          {loading ? CLIENTS_CHECKING_LABEL : CLIENTS_REFRESH_LABEL}
        </Button>
      </div>

      {error !== '' && clients === null && (
        <p role="alert" className="text-sm text-destructive">{CLIENTS_UNAVAILABLE_TITLE} {error}</p>
      )}
      {error !== '' && clients !== null && (
        <p role="alert" className="text-sm text-destructive">{error}</p>
      )}

      <div className="overflow-hidden rounded-xl border bg-card">
        <ul className="flex flex-col divide-y">
          {clients === null && loading
            ? [0, 1, 2].map((index) => (
                <li key={index} className="flex items-center gap-2 px-3 py-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="ml-auto h-4 w-16" />
                </li>
              ))
            : (clients ?? []).map((entry) => {
                const badge = (
                  <StatusBadge
                    tone={READINESS_TONE[entry.readiness]}
                    label={READINESS_LABEL[entry.readiness]}
                  />
                );
                const rowError = rowErrors[entry.id];
                return (
                  <li key={entry.id} className="flex flex-col gap-1 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 shrink-0 truncate font-medium">{entry.name}</span>
                      {entry.version !== undefined && (
                        <span className="shrink-0 text-xs text-muted-foreground">{entry.version}</span>
                      )}
                      <span className="shrink-0 text-xs text-muted-foreground">{sourceLabel(entry)}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {entry.path ?? ''}
                      </span>
                      {entry.reason !== undefined ? (
                        <Tooltip>
                          <TooltipTrigger render={<span />}>{badge}</TooltipTrigger>
                          <TooltipContent>{entry.reason}</TooltipContent>
                        </Tooltip>
                      ) : badge}
                      <span className="ml-2 shrink-0">{renderActions(entry)}</span>
                    </div>
                    {entry.lastError !== undefined && (
                      <p role="alert" className="text-xs text-destructive">{entry.lastError}</p>
                    )}
                    {rowError !== undefined && (
                      <p role="alert" className="text-xs text-destructive">{rowError}</p>
                    )}
                  </li>
                );
              })}
        </ul>
      </div>

      <p className="text-xs text-muted-foreground">{CLIENTS_SCOPE_NOTE}</p>
    </div>
  );
}
