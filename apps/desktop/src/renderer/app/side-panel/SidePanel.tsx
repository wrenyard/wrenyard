import type { CSSProperties } from 'react';
import { SIDE_PANEL_VIEWS } from './views';
import { useSidePanelResize } from './useSidePanelResize';
import { useSidePanelState } from '@/renderer/lib/side-panel';

export function SidePanel({ reservedWidth }: { reservedWidth: number }) {
  const { view } = useSidePanelState();
  const resize = useSidePanelResize(view !== null, reservedWidth);
  if (view === null) return null;
  const entry = SIDE_PANEL_VIEWS[view];
  const Content = entry.Content;

  return (
    <aside
      className="relative flex w-(--side-panel-width) min-h-0 shrink-0 flex-col border-l bg-background"
      data-side-panel
      style={{ '--side-panel-width': `${resize.width}px` } as CSSProperties}
    >
      <div {...resize.handleProps} />
        <Content key={view} />
    </aside>
  );
}
