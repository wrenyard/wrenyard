/** A single transient Pet bubble. It fades out at untilMs and can also be dismissed by the user. */
export interface BroadcastSnapshot {
  id: string;
  text: string;
  untilMs: number;
}

export type BroadcastInput = BroadcastSnapshot;

export function normalizeBroadcast(input: BroadcastInput): BroadcastSnapshot {
  return { id: input.id, text: input.text, untilMs: input.untilMs };
}

export function shouldExpireBroadcast(broadcast: BroadcastSnapshot, nowMs: number): boolean {
  return nowMs >= broadcast.untilMs;
}
