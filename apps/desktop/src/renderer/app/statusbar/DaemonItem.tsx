import type { ReactNode } from 'react';
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
} from '@/shell-contract';
import { cn } from 'cn';

/**
 * Status-bar daemon item (window-chrome spec 4.2). Its dot is always the single
 * source of daemon health: green while running, a spinner while starting, and
 * red whenever the process is stopped, failed, or unreachable. The popover adds
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

  let indicator: ReactNode;
  if (starting) {
    indicator = <Spinner className="size-3.5" />;
  } else if (snapshot?.state === 'running') {
    indicator = <span className="size-2 shrink-0 rounded-full bg-success" />;
  } else {
    indicator = <span className="size-2 shrink-0 rounded-full bg-current" />;
  }

  const label = (
    <span className="flex items-center gap-1">
      {indicator}
      Daemon
    </span>
  );
  const tooltip = disconnected ? (snapshot?.message ?? 'Daemon 已断开') : lifecycleLabel(snapshot);

  const handleRestart = async (): Promise<void> => {
    const confirmed = await confirm({ title: '重启 Daemon？', confirmLabel: '重启', destructive: true });
    if (confirmed) void shell.restartDaemon();
  };

  return (
    <Popover>
      <PopoverTrigger nativeButton={false} render={<span className="inline-flex" />}>
        <StatusBarButton label={label} tooltip={tooltip} ariaLabel="Daemon 状态" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72">
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
      </PopoverContent>
    </Popover>
  );
}
