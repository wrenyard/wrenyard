import type { ServiceSnapshot } from './shell-contract.js';

export interface DaemonStatusPresentation {
  status: ServiceSnapshot['status'];
  label: string;
  startedAt?: number;
}

export function daemonStatusPresentation(
  service: Pick<ServiceSnapshot, 'status' | 'uptimeMs'>,
  now = Date.now(),
): DaemonStatusPresentation {
  if (service.status !== 'connected') {
    return { status: 'unavailable', label: 'Daemon 离线' };
  }
  const uptimeMs = typeof service.uptimeMs === 'number' && Number.isFinite(service.uptimeMs)
    ? Math.max(0, service.uptimeMs)
    : undefined;
  return {
    status: 'connected',
    label: 'Daemon 在线',
    ...(uptimeMs !== undefined ? { startedAt: now - uptimeMs } : {}),
  };
}
