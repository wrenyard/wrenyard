export const BROADCAST_INTENSITIES = ['transient', 'sticky', 'critical'] as const;

/**
 * Notification persistence level.
 *
 * transient: auto-dismisses at untilMs when provided.
 * sticky: default for missing intensity; only close/X dismisses it.
 * critical: persistent like sticky, reserved for stronger visual treatment.
 */
export type BroadcastIntensity = typeof BROADCAST_INTENSITIES[number];

export interface BroadcastSnapshot {
  id?: string;
  text: string;
  intensity: BroadcastIntensity;
  untilMs?: number;
}

export type BroadcastInput = Omit<BroadcastSnapshot, 'intensity'> & {
  intensity?: BroadcastIntensity;
};

export function isBroadcastIntensity(value: unknown): value is BroadcastIntensity {
  return typeof value === 'string' && BROADCAST_INTENSITIES.includes(value as BroadcastIntensity);
}

export function normalizeBroadcast(input: BroadcastInput): BroadcastSnapshot {
  return {
    ...input,
    intensity: input.intensity ?? 'sticky',
  };
}

export function shouldExpireBroadcast(broadcast: BroadcastSnapshot, nowMs: number): boolean {
  return (
    broadcast.intensity === 'transient' &&
    typeof broadcast.untilMs === 'number' &&
    nowMs >= broadcast.untilMs
  );
}
