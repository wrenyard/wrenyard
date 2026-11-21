import { useRef, type CSSProperties } from 'react';
import { cn } from 'cn';
import { SIDE_PANEL_VIEWS } from './views';
import { useSidePanelResize } from './useSidePanelResize';
import { useSidePanelState } from '@/renderer/lib/side-panel';
import { useAnimatedPresence } from '@/renderer/lib/motion';

/**
 * M3 floating companion sheet on the shell's inline-end edge. The panel stays
 * mounted through its exit so `useAnimatedPresence` can play the slide-out and
 * fade: `entering`/`exiting` collapse it to zero width (and drop the desktop
 * margin so no gap remains), `open` restores the resizable width. The width,
 * transform and opacity transition is suppressed while the separator is
 * dragged so resizing tracks the pointer exactly.
 */
export function SidePanel({ reservedWidth }: { reservedWidth: number }) {
  const { view } = useSidePanelState();
  // Remember the last view so the exit animation has content to animate.
  const lastViewRef = useRef(view);
  if (view !== null) lastViewRef.current = view;
  const presence = useAnimatedPresence(view !== null, 240);
  const resize = useSidePanelResize(view !== null, reservedWidth);
  if (!presence.mounted) return null;
  const activeView = view ?? lastViewRef.current;
  if (activeView === null) return null;
  const entry = SIDE_PANEL_VIEWS[activeView];
  const Content = entry.Content;

  return (
    <aside
      className={cn(
        'relative flex min-h-0 shrink-0 flex-col overflow-hidden rounded-[20px] bg-surface-container-low ring-1 ring-border/55 shadow-[var(--elevation-1)] md:mr-2 md:mb-2',
        presence.state === 'open'
          ? 'w-(--side-panel-width) translate-x-0 opacity-100'
          : 'w-0 translate-x-4 opacity-0 md:mr-0',
        !resize.resizing
          && 'transition-[width,margin,transform,opacity] duration-[340ms] ease-[var(--ease-m3-spring-spatial)]',
      )}
      data-side-panel
      data-presence={presence.state}
      style={{ '--side-panel-width': `${resize.width}px` } as CSSProperties}
    >
      <div {...resize.handleProps} />
      <Content key={activeView} />
    </aside>
  );
}
