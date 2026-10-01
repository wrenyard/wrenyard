// ── Overlay DOM UI layer ─────────────────────────────────────────────
// The inert layer that sits above the Pixi sprite canvas. Only descendants
// that opt in with `data-hit` (plus `pointer-events-auto`) receive the
// pointer; everything else stays click-through so transparent sprite pixels
// and empty space pass to the window below.

import { useEffect, useState, type ReactNode } from 'react';

export function OverlayUi({ children }: { children?: ReactNode }) {
  return (
    <div data-overlay-ui className="pointer-events-none absolute inset-0">
      {children}
    </div>
  );
}

/**
 * Shared re-render clock for countdown/fade chrome (quota reset times,
 * transient broadcast fade, worker bubble fade). Overlay UI is otherwise
 * driven by pushed Pet state, so a coarse cadence keeps React quiet.
 */
export function useNow(intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return now;
}
