import type { BroadcastSnapshot } from '../../../shared/snapshot';

export const BROADCAST_FADE_MS = 800;

export function broadcastAlpha(
  broadcast: BroadcastSnapshot | undefined,
  nowMs: number,
): number {
  if (!broadcast) return 0;
  if (broadcast.intensity !== 'transient') return 1;
  if (typeof broadcast.untilMs !== 'number') return 1;

  const remaining = broadcast.untilMs - nowMs;
  if (remaining <= 0) return 0;
  if (remaining >= BROADCAST_FADE_MS) return 1;
  return remaining / BROADCAST_FADE_MS;
}

export function shouldRenderBroadcast(
  broadcast: BroadcastSnapshot | undefined,
  nowMs: number,
): boolean {
  return broadcastAlpha(broadcast, nowMs) > 0;
}
