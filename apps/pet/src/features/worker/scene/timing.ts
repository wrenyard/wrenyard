/**
 * Live-only animation timing constants and pulse helpers.
 *
 * Defines production gesture and tool-flash durations used by worker entity
 * rendering.
 *
 * FU-002 / IU-001
 */

export const ANIM_FRAME_MS = 320;       // ms per sprite-animation frame
export const ACTIVITY_PULSE_MS = 520;   // activity bob pulse window
export const CONTENT_GESTURE_MS = 320;  // equals ANIM_FRAME_MS
export const TOOL_FLASH_MS = 2200;      // tool-call flash lifetime

/** Activity bob offset (0 or -1..-3), clamped to [-3,0]. Returns 0 when inactive. */
export function activityPulseOffset(nowMs: number, activityPulseMs?: number): number {
  if (activityPulseMs === undefined) return 0;
  const age = nowMs - activityPulseMs;
  if (!Number.isFinite(age) || age < 0 || age > ACTIVITY_PULSE_MS) return 0;
  const t = age / ACTIVITY_PULSE_MS;
  return -Math.max(1, Math.round(Math.sin((1 - t) * Math.PI) * 3));
}

/** 1px hand shift during the content-gesture window, else 0. */
export function contentGestureShift(nowMs: number, contentPulseMs?: number): number {
  if (contentPulseMs === undefined) return 0;
  const age = nowMs - contentPulseMs;
  if (!Number.isFinite(age) || age < 0 || age >= CONTENT_GESTURE_MS) return 0;
  return 1;
}

/** Non-hover tool-flash alpha for a flash that began at lastToolTs. */
export function toolFlashAlpha(nowMs: number, lastToolTs?: number): number {
  if (lastToolTs === undefined) return 0;
  const age = nowMs - lastToolTs;
  if (!Number.isFinite(age) || age < 0 || age >= TOOL_FLASH_MS) return 0;
  return Math.min(1, (1 - age / TOOL_FLASH_MS) * 1.6);
}
