import type { StatusTone } from '@/renderer/components/status-badge';
import type { ScheduleState } from '@/shell-contract';

/* Pure view model for the schedules page: page copy, state labels and the
 * frequency text rules. No React, DOM or bridge access lives here. */

export const PAGE_TITLE = '定时任务';

/** Display label and shared status tone of every schedule state. */
export const STATE_VIEW: Record<ScheduleState, { label: string; tone: StatusTone }> = {
  active: { label: '运行中', tone: 'success' },
  paused: { label: '已暂停', tone: 'muted' },
  finished: { label: '已完成', tone: 'muted' },
  failed: { label: '失败', tone: 'danger' },
};

/** Largest unit that divides the interval in whole: days, then hours, else minutes. */
function frequencyUnit(intervalMinutes: number): { value: number; unit: string } {
  if (intervalMinutes % 1440 === 0) return { value: intervalMinutes / 1440, unit: '天' };
  if (intervalMinutes % 60 === 0) return { value: intervalMinutes / 60, unit: '小时' };
  return { value: intervalMinutes, unit: '分钟' };
}

/** `每 N 分钟` for a recurring schedule; `N 分钟后一次` for a one-shot. */
export function frequencyText(intervalMinutes: number, recurring: boolean): string {
  const { value, unit } = frequencyUnit(intervalMinutes);
  return recurring ? `每 ${value} ${unit}` : `${value} ${unit}后一次`;
}
