import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { StatusBadge, type StatusTone } from '@/renderer/components/status-badge';
import { Button } from '@/renderer/components/ui/button';
import { Skeleton } from '@/renderer/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip';
import { clientList } from '@/renderer/lib/desktop';
import type { ClientListEntry, ClientReadiness } from '@/shell-contract';
import { errorMessage } from '../model/settings.js';

const CLIENTS_UNAVAILABLE_TITLE = '客户端状态暂时不可用。';
const CLIENTS_REFRESH_LABEL = '重新检测';
const CLIENTS_CHECKING_LABEL = '检测中…';
const CLIENTS_SCOPE_NOTE = '列表由守护进程检测并上报，此页面为只读，不提供安装或启用操作。';

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

/**
 * Read-only 客户端 page: one row per supported agent client reported by the
 * daemon's `client.list` method — display name and version, a labelled status
 * badge (reason shown in a tooltip on non-ready states) and the detected
 * executable path. The 重新检测 button re-runs the detection. No install,
 * upgrade or enable actions exist here.
 */
export function ClientsSettings() {
  const [clients, setClients] = useState<ClientListEntry[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await clientList();
      setClients(result.clients);
      setError('');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">已支持客户端的运行环境状态</span>
        <Button
          variant="outline"
          className="shrink-0"
          disabled={loading}
          onClick={() => { void refresh(); }}
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
                return (
                  <li key={entry.id} className="flex items-center gap-2 px-3 py-2">
                    <span className="min-w-0 shrink-0 truncate font-medium">{entry.name}</span>
                    {entry.version !== undefined && (
                      <span className="shrink-0 text-xs text-muted-foreground">{entry.version}</span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {entry.path ?? ''}
                    </span>
                    {entry.reason !== undefined ? (
                      <Tooltip>
                        <TooltipTrigger render={<span />}>{badge}</TooltipTrigger>
                        <TooltipContent>{entry.reason}</TooltipContent>
                      </Tooltip>
                    ) : badge}
                  </li>
                );
              })}
        </ul>
      </div>

      <p className="text-xs text-muted-foreground">{CLIENTS_SCOPE_NOTE}</p>
    </div>
  );
}
