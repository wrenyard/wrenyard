import { ChartColumn, Download, ListChecks, MessagesSquare, Settings, WalletCards } from 'lucide-react';
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
  { id: 'stats', label: '工房台账', icon: ChartColumn },
  { id: 'quota', label: '模型供应', icon: WalletCards },
  { id: 'tasks', label: '任务', icon: ListChecks },
];

/** Settings lives in the rail footer, not the primary content list. */
export const SETTINGS_NAV: ShellNavItem = {
  id: 'settings',
  label: '啾啾工坊设置',
  icon: Settings,
};

/** The update entry appears in the footer only while an update is actionable. */
export const UPDATE_NAV = {
  id: 'update',
  label: '软件更新',
  icon: Download,
} as const;

/** Update states that keep the footer entry and dialog reachable. */
export const UPDATE_VISIBLE_STATES = ['available', 'waiting', 'installing', 'error'] as const;
