import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, HTMLAttributes, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { cn } from 'cn';

/** Default activity panel width, in CSS pixels. */
export const ACTIVITY_PANEL_DEFAULT_WIDTH = 380;
/** Smallest the activity panel may become while dragged. */
export const ACTIVITY_PANEL_MIN_WIDTH = 280;
/** Largest the activity panel may become on a wide window. */
export const ACTIVITY_PANEL_MAX_WIDTH = 640;
/** The main area keeps at least this much room on a narrow window. */
const MAIN_AREA_RESERVE = 320;
/** Half the separator's 6px hit strip, so it straddles the boundary. */
const HANDLE_HALF_WIDTH = 3;
/** Keyboard resize step. */
const KEYBOARD_STEP = 16;
/** The user's preferred width is remembered under this app-shell-specific key. */
const STORAGE_KEY = 'wrenyard.shell.activity-panel-width';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The widest the panel may be right now, from the live viewport width. */
function viewportCap(): number {
  return Math.max(
    ACTIVITY_PANEL_MIN_WIDTH,
    Math.min(ACTIVITY_PANEL_MAX_WIDTH, window.innerWidth - MAIN_AREA_RESERVE),
  );
}

/** Reads the remembered width, tolerating missing, invalid or unavailable storage. */
function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Persists the committed width; resizing still works when storage is unavailable. */
function writeStoredWidth(value: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Storage can be blocked (private mode, quota); the width just is not kept.
  }
}

export interface ActivityPanelResize {
  /** The width the activity panel renders at right now, in CSS pixels. */
  width: number;
  /** True while a drag is in progress, so width transitions can be suppressed. */
  resizing: boolean;
  /** Props for the separator element; spread onto a `div`. */
  handleProps: HTMLAttributes<HTMLDivElement>;
}

/**
 * Right-side activity-panel resizing, the mirror of the left shell sidebar:
 * the user's preferred width is kept separately from the rendered width, so a
 * narrow window (which caps the panel at `viewport width - 320px`) never
 * overwrites the preferred value. The returned `handleProps` drive a 6px
 * vertical separator on the panel's left boundary; dragging left widens the
 * panel.
 */
export function useActivityPanelResize(enabled: boolean): ActivityPanelResize {
  const [preferred, setPreferred] = useState<number>(() =>
    clamp(readStoredWidth() ?? ACTIVITY_PANEL_DEFAULT_WIDTH, ACTIVITY_PANEL_MIN_WIDTH, ACTIVITY_PANEL_MAX_WIDTH),
  );
  const [viewportWidth, setViewportWidth] = useState<number>(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);

  const preferredRef = useRef(preferred);
  preferredRef.current = preferred;

  // Cap on a narrow window, but never below the minimum.
  const cap = Math.max(
    ACTIVITY_PANEL_MIN_WIDTH,
    Math.min(ACTIVITY_PANEL_MAX_WIDTH, viewportWidth - MAIN_AREA_RESERVE),
  );
  const width = clamp(preferred, ACTIVITY_PANEL_MIN_WIDTH, cap);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Tear an in-flight drag down if the shell unmounts mid-drag.
  const endResizeRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endResizeRef.current?.(), []);
  // The handle can disappear while a drag is live (panel close), so
  // `lostpointercapture` may never reach the window: end the drag whenever the
  // hook turns disabled.
  useEffect(() => {
    if (!enabled) endResizeRef.current?.();
  }, [enabled]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!enabled) return;
      if (event.button !== 0 || !event.isPrimary) return;
      endResizeRef.current?.();
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startWidth = widthRef.current;
      event.preventDefault();
      try {
        target.setPointerCapture(pointerId);
      } catch {
        // Capture is best-effort; window listeners below still drive the drag.
      }
      setResizing(true);
      const previousUserSelect = document.body.style.userSelect;
      const previousCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      let done = false;
      const onMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) return;
        // Right-anchored: dragging left (negative delta) widens the panel.
        const next = clamp(
          Math.round(startWidth - (moveEvent.clientX - startX)),
          ACTIVITY_PANEL_MIN_WIDTH,
          viewportCap(),
        );
        preferredRef.current = next;
        setPreferred(next);
      };
      function end(): void {
        if (done) return;
        done = true;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', endFromPointer);
        window.removeEventListener('pointercancel', endFromPointer);
        window.removeEventListener('lostpointercapture', endFromPointer);
        window.removeEventListener('blur', end);
        try {
          target.releasePointerCapture(pointerId);
        } catch {
          // Already released by the browser.
        }
        document.body.style.userSelect = previousUserSelect;
        document.body.style.cursor = previousCursor;
        setResizing(false);
        writeStoredWidth(preferredRef.current);
        endResizeRef.current = null;
      }
      function endFromPointer(pointerEvent: PointerEvent): void {
        if (pointerEvent.pointerId !== pointerId) return;
        end();
      }

      endResizeRef.current = end;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', endFromPointer);
      window.addEventListener('pointercancel', endFromPointer);
      window.addEventListener('lostpointercapture', endFromPointer);
      window.addEventListener('blur', end);
    },
    [enabled],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!enabled) return;
      let next: number | null = null;
      if (event.key === 'ArrowLeft') next = widthRef.current + KEYBOARD_STEP;
      else if (event.key === 'ArrowRight') next = widthRef.current - KEYBOARD_STEP;
      else if (event.key === 'Home') next = ACTIVITY_PANEL_MIN_WIDTH;
      else if (event.key === 'End') next = viewportCap();
      if (next === null) return;
      event.preventDefault();
      const value = clamp(next, ACTIVITY_PANEL_MIN_WIDTH, viewportCap());
      preferredRef.current = value;
      setPreferred(value);
      writeStoredWidth(value);
    },
    [enabled],
  );

  const handleProps: HTMLAttributes<HTMLDivElement> = {
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': '调整活动面板宽度',
    'aria-valuenow': Math.round(width),
    'aria-valuemin': ACTIVITY_PANEL_MIN_WIDTH,
    'aria-valuemax': Math.round(cap),
    'aria-valuetext': `${Math.round(width)} 像素`,
    tabIndex: enabled ? 0 : -1,
    className: cn(
      'fixed z-20 w-1.5 touch-none select-none bg-transparent outline-none',
      'cursor-col-resize [-webkit-app-region:no-drag] [app-region:no-drag]',
      'hover:bg-sidebar-border/60 focus-visible:bg-sidebar-border/80',
      resizing && 'bg-sidebar-border/80',
    ),
    style: {
      // The panel is pinned to the right edge, so its width from the right is
      // the boundary.
      right: `calc(var(--activity-panel-width, 380px) - ${HANDLE_HALF_WIDTH}px)`,
      top: 'var(--titlebar-height)',
      height: 'calc(100svh - var(--titlebar-height))',
    } as CSSProperties,
    onPointerDown,
    onKeyDown,
  };

  return { width, resizing, handleProps };
}
