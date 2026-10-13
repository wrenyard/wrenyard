import { Plug, Unplug } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/renderer/components/ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/renderer/components/ui/popover';
import { Spinner } from '@/renderer/components/ui/spinner';
import { StatusBarButton } from '@/renderer/components/status-bar-button';
import { useConfirm } from '@/renderer/hooks/use-confirm';
import { shell } from '@/renderer/lib/desktop';
import { daemonQuery, settingsQuery } from '@/renderer/lib/queries';
import type {
  DaemonConnectionMode,
  DaemonLifecycleSnapshot,
  DaemonProcessState,
  ServiceSnapshot,
} from '@/shell-contract';
import { cn } from 'cn';

/**
 * Status-bar daemon item (window-chrome spec 4.2). An icon shows connection
 * health, with the full state in its tooltip. The popover adds
 * version, uptime, IPC endpoint and lifecycle ownership, plus a restart action
 * when the daemon is Desktop-supervised.
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
  if (runtimeMode === 'source') return '在线（本地 · 开发）';
  if (runtimeMode === 'installed') {
    return snapshot.mode === 'connected' ? '在线（本地 · CLI）' : '在线（本地）';
  }
  return snapshot.mode === 'supervised' ? '在线（本地）' : '在线';
}

function lifecycleLabel(snapshot: DaemonLifecycleSnapshot | undefined): string {
  if (snapshot === undefined) return '未知';
  return `${MODE_LABEL[snapshot.mode]} · ${STATE_LABEL[snapshot.state]}`;
}

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

export function DaemonItem() {
  const daemon = useQuery(daemonQuery);
  const settings = useQuery(settingsQuery);
  const confirm = useConfirm();
  const snapshot = daemon.data;
  const starting = snapshot?.state === 'starting' || (snapshot === undefined && daemon.isPending);
  const disconnected = isDaemonDisconnected(snapshot);

  const status = starting ? '连接中' : connectionLabel(snapshot, settings.data?.service.runtimeMode);
  const detail = disconnected ? (snapshot?.message ?? 'Daemon 已断开') : lifecycleLabel(snapshot);
  const tooltip = `${status} · ${detail}`;

  const handleRestart = async (): Promise<void> => {
    const confirmed = await confirm({ title: '重启 Daemon？', confirmLabel: '重启', destructive: true });
    if (confirmed) void shell.restartDaemon();
  };

  return (
    <Popover>
      <PopoverTrigger nativeButton={false} render={<span className="inline-flex" />}>
        <StatusBarButton
          icon={starting ? undefined : snapshot?.state === 'running' ? Plug : Unplug}
          tooltip={tooltip}
          ariaLabel="连接状态"
          tone={disconnected ? 'destructive' : 'default'}
        >
          {starting ? <Spinner className="size-3.5" /> : null}
        </StatusBarButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72">
        <PopoverTitle>连接状态</PopoverTitle>
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
      </PopoverContent>
    </Popover>
  );
}
