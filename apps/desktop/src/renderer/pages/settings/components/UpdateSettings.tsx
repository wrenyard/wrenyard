import { useEffect, useRef, useState } from 'react';
import { UpdatePanel } from '@/renderer/components/update-panel';

/**
 * Current-version status: the shared update panel (version, last check, and
 * the check/install actions). The `update.autoCheck` row lives beside it as a
 * standard preference control. Every settings category page stays mounted and
 * only the selected one is visible, so the panel is told when this section is
 * actually on screen: each time it becomes visible it runs its own fresh check
 * instead of reusing the result from the first render.
 */
export function UpdateStatusControl() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const observer = new IntersectionObserver((entries) => {
      setActive(entries.some((entry) => entry.isIntersecting));
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={hostRef} className="w-full">
      <UpdatePanel active={active} />
    </div>
  );
}
