import { useState } from 'react';
import { ArrowUp, ChevronUp, Gauge, Info, Plug, Unplug, WalletCards } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/renderer/components/ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/renderer/components/ui/popover';
import { Separator } from '@/renderer/components/ui/separator';
import { Spinner } from '@/renderer/components/ui/spinner';
import { useConfirm } from '@/renderer/hooks/use-confirm';
import { PRIMARY_NAV, UPDATE_VISIBLE_STATES } from '@/renderer/app/nav';
import { executeCommand } from '@/renderer/lib/commands';
import { shell } from '@/renderer/lib/desktop';
import { daemonQuery, settingsQuery, updateQuery } from '@/renderer/lib/queries';
import { updateView } from '@/renderer/lib/update';
import type {
  DaemonConnectionMode,
  DaemonLifecycleSnapshot,
  DaemonProcessState,
  ServiceSnapshot,
} from '@/shell-contract';
import { cn } from 'cn';

/**
 * Sidebar Daemon button (window-chrome spec 4.2, moved out of the status bar). A
 * long button shows the connection icon, the truthful environment label and a
 * small connectivity dot, and opens a menu with the daemon version, uptime, IPC
 * endpoint and lifecycle ownership, a restart action when the daemon is
 * Desktop-supervised, the usage, trace, ledger and about destinations, and the
 * update entry.
 * While an update is actionable, a compact direct-dialog update-icon button
 * renders beside the trigger so it stays discoverable without opening the menu.
 */

const DISCONNECTED_STATES: ReadonlySet<DaemonProcessState> = new Set<DaemonProcessState>([
  'stopped',
  'failed',
  'unavailable',
]);

/** True while the daemon is absent or in a terminal non-running state. */
export function isDaemonDisconnected(snapshot: DaemonLifecycleSnapshot | undefined): boolean {
  return snapshot !== undefined && DISCONNECTED_STATES.has(snapshot.state);
}

const MODE_LABEL: Readonly<Record<DaemonConnectionMode, string>> = {
  supervised: '由啾啾工坊启动',
  connected: '由终端管理',
};

const STATE_LABEL: Readonly<Record<DaemonProcessState, string>> = {
  starting: '启动中',
  running: '运行中',
  stopped: '已停止',
  failed: '失败',
  unavailable: '不可用',
};

function connectionLabel(
  snapshot: DaemonLifecycleSnapshot | undefined,
  runtimeMode: ServiceSnapshot['runtimeMode'],
): string {
  if (snapshot?.state !== 'running') {
    return snapshot?.state === 'starting' ? '连接中' : '离线';
  }
  return runtimeMode === 'source' ? '开发模式' : '本地';
}

function lifecycleLabel(snapshot: DaemonLifecycleSnapshot | undefined): string {
  if (snapshot === undefined) return '未知';
  return `${MODE_LABEL[snapshot.mode]} · ${STATE_LABEL[snapshot.state]}`;
}

/** Connectivity dot tone, derived from the same state as the environment label. */
type ConnectivityTone = 'online' | 'starting' | 'offline' | 'unknown';

const DOT_CLASS: Readonly<Record<ConnectivityTone, string>> = {
  online: 'bg-success',
  starting: 'bg-warning',
  offline: 'bg-destructive',
  unknown: 'bg-muted-foreground',
};

/** Chinese uptime such as `2 小时 5 分`; em dash when unknown. */
function formatUptime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '—';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分`);
  return parts.length === 0 ? '刚刚启动' : parts.join(' ');
}

function LifecycleRow({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 flex-1', valueClassName)}>{value}</dd>
    </div>
  );
}

export interface DaemonItemProps {
  /** Opens the shared update dialog (the status-bar update entry's old action). */
  onOpenUpdate: () => void;
}

export function DaemonItem({ onOpenUpdate }: DaemonItemProps) {
  const daemon = useQuery(daemonQuery);
  const settings = useQuery(settingsQuery);
  const update = useQuery(updateQuery);
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const snapshot = daemon.data;
  const starting = snapshot?.state === 'starting' || (snapshot === undefined && daemon.isPending);
  const disconnected = isDaemonDisconnected(snapshot);

  const status = starting ? '连接中' : connectionLabel(snapshot, settings.data?.service.runtimeMode);
  const tone: ConnectivityTone = starting
    ? 'starting'
    : disconnected
      ? 'offline'
      : snapshot?.state === 'running'
        ? 'online'
        : 'unknown';

  const updateState = update.data?.state;
  const updateVisible =
    updateState !== undefined && UPDATE_VISIBLE_STATES.some((visible) => visible === updateState);
  const updateStatus = update.data === undefined ? undefined : updateView(update.data, update.isPending).label;
  const currentVersion = update.data?.currentVersion ?? settings.data?.about.wrenyardVersion;
  const updateSummary = [currentVersion === undefined ? undefined : `v${currentVersion}`, updateStatus]
    .filter((part): part is string => part !== undefined)
    .join(' · ');

  const handleRestart = async (): Promise<void> => {
    const confirmed = await confirm({ title: '重启 Daemon？', confirmLabel: '重启', destructive: true });
    if (confirmed) void shell.restartDaemon();
  };

  const openUsage = (): void => {
    setOpen(false);
    executeCommand('settings.open', 'providers');
  };

  const openProviders = (): void => {
    setOpen(false);
    executeCommand('settings.open', 'providers');
  };

  const openAbout = (): void => {
    setOpen(false);
    executeCommand('settings.open', 'about');
  };

  const openUpdate = (): void => {
    setOpen(false);
    onOpenUpdate();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger nativeButton={false} render={<span className="inline-flex min-w-0 flex-1" />}>
        <Button
          type="button"
          variant="ghost"
          title={status}
          aria-label={`Daemon 连接状态：${status}`}
          aria-haspopup="dialog"
          className="h-7 w-full min-w-0 justify-start gap-1.5 rounded-xl px-2 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {starting ? (
            <Spinner className="size-4 shrink-0" />
          ) : snapshot?.state === 'running' ? (
            <Plug className="size-4 shrink-0" />
          ) : (
            <Unplug className="size-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate text-left">{status}</span>
          <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[tone])} />
          <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      {updateVisible ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 rounded-full hover:bg-sidebar-accent"
          title={updateStatus ?? '有可用更新'}
          aria-label={updateStatus ?? '有可用更新'}
          onClick={openUpdate}
        >
          <span aria-hidden className="flex size-5 items-center justify-center rounded-full bg-warning text-white shadow-sm">
            <ArrowUp className="size-3.5" strokeWidth={2.75} />
          </span>
        </Button>
      ) : null}
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 max-w-[calc(100vw-2rem)] max-h-[min(70vh,36rem)] overflow-y-auto"
      >
        <PopoverTitle>Daemon</PopoverTitle>
        <dl className="flex flex-col gap-1.5 text-xs">
          <LifecycleRow label="版本" value={settings.data?.about.wrenyardVersion ?? '—'} />
          <LifecycleRow label="运行时长" value={formatUptime(settings.data?.service.uptimeMs)} />
          <LifecycleRow
            label="IPC 路径"
            value={settings.data?.service.endpoint ?? '—'}
            valueClassName="break-all"
          />
          <LifecycleRow label="生命周期" value={lifecycleLabel(snapshot)} />
        </dl>
        {snapshot?.canStart ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void handleRestart()}>
            重启
          </Button>
        ) : null}
        <Separator />
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="justify-start gap-2"
            onClick={openUsage}
          >
            <Gauge />
            <span>用量</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="justify-start gap-2"
            onClick={openProviders}
          >
            <WalletCards />
            <span>供应商</span>
          </Button>
          {/* Destinations the sidebar header no longer exposes stay reachable here. */}
          {PRIMARY_NAV.filter((item) => item.id === 'trace' || item.id === 'stats').map((item) => (
            <Button
              key={item.id}
              type="button"
              variant="ghost"
              size="sm"
              className="justify-start gap-2"
              onClick={() => {
                setOpen(false);
                void shell.navigate(item.id);
              }}
            >
              <item.icon />
              <span>{item.label}</span>
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="justify-start gap-2"
            onClick={openAbout}
          >
            <Info />
            <span>关于</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="justify-start gap-2"
            onClick={openUpdate}
          >
            <ArrowUp className={cn(updateVisible && 'text-warning')} />
            <span>软件更新</span>
            {updateSummary !== '' ? (
              <span className="ml-auto truncate text-xs text-muted-foreground">{updateSummary}</span>
            ) : null}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
