import { Bot, ChartColumn, ListChecks, MessagesSquare, Network, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ShellPage } from '@/shell-contract';

/** Canonical shell page navigation entry. */
export interface ShellNavItem {
  id: ShellPage;
  label: string;
  icon: LucideIcon;
}

/** Primary shell navigation, rendered once in the activity rail. */
export const PRIMARY_NAV: readonly ShellNavItem[] = [
  { id: 'session', label: '会话', icon: MessagesSquare },
  { id: 'trace', label: '追踪', icon: Network },
  { id: 'stats', label: '工房台账', icon: ChartColumn },
  { id: 'tasks', label: '任务', icon: ListChecks },
  { id: 'agents', label: '机器人', icon: Bot },
  { id: 'bot', label: '旧版机器人', icon: Bot },
];

/** Settings lives in the rail footer, not the primary content list. */
export const SETTINGS_NAV: ShellNavItem = {
  id: 'settings',
  label: '啾啾工坊设置',
  icon: Settings,
};

/** The update entry appears in the global sidebar footer only while actionable. */
export const UPDATE_VISIBLE_STATES = ['available', 'waiting', 'installing', 'error'] as const;
