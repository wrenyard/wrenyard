import type { ComponentType } from 'react';
import type { SidePanelViewId } from '@/renderer/lib/side-panel';
import { BackgroundTasksIcon, BackgroundTasksView } from './BackgroundTasksView';

export interface SidePanelViewEntry {
  title: string;
  Icon: ComponentType;
  Content: ComponentType;
}

export const SIDE_PANEL_VIEWS: Record<SidePanelViewId, SidePanelViewEntry> = {
  tasks: { title: '后台任务', Icon: BackgroundTasksIcon, Content: BackgroundTasksView },
};

export const SIDE_PANEL_VIEW_ORDER: readonly SidePanelViewId[] = ['tasks'];
