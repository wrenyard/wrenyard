import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, HTMLAttributes, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { cn } from 'cn';

/** Default shell left-sidebar width, in CSS pixels. */
export const SHELL_SIDEBAR_DEFAULT_WIDTH = 256;
/** Smallest the shell left sidebar may become while dragged. */
export const SHELL_SIDEBAR_MIN_WIDTH = 200;
/** Largest the shell left sidebar may become on a wide window. */
export const SHELL_SIDEBAR_MAX_WIDTH = 480;
/** The main area keeps at least this much room on a narrow window. */
const MAIN_AREA_RESERVE = 320;
/** Half the separator's 6px hit strip, so it straddles the boundary. */
const HANDLE_HALF_WIDTH = 3;
/** Keyboard resize step. */
const KEYBOARD_STEP = 16;
/** The user's preferred width is remembered under this app-shell-specific key. */
const STORAGE_KEY = 'wrenyard.shell.sidebar-width';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The widest the sidebar may be right now, from the live viewport width. */
function viewportCap(): number {
  return Math.max(
    SHELL_SIDEBAR_MIN_WIDTH,
    Math.min(SHELL_SIDEBAR_MAX_WIDTH, window.innerWidth - MAIN_AREA_RESERVE),
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

export interface ShellSidebarResize {
  /** The width the shell sidebar renders at right now, in CSS pixels. */
  width: number;
  /** True while a drag is in progress, so width transitions can be suppressed. */
  resizing: boolean;
  /** Props for the separator element; spread onto a `div`. */
  handleProps: HTMLAttributes<HTMLDivElement>;
}

/**
 * Shell left-sidebar resizing. The user's preferred width is kept separately
 * from the rendered width, so a narrow window (which caps the sidebar at
 * `viewport width - 320px`) never overwrites the preferred value: widening the
 * window restores it. The preferred width is remembered under an app-shell key.
 * The returned `handleProps` drive a 6px vertical separator placed on the
 * sidebar/main boundary; it only responds to a primary left-pointer drag with
 * pointer capture, and to Left/Right/Home/End when focused.
 */
export function useShellSidebarResize(enabled: boolean): ShellSidebarResize {
  const [preferred, setPreferred] = useState<number>(() =>
    clamp(readStoredWidth() ?? SHELL_SIDEBAR_DEFAULT_WIDTH, SHELL_SIDEBAR_MIN_WIDTH, SHELL_SIDEBAR_MAX_WIDTH),
  );
  const [viewportWidth, setViewportWidth] = useState<number>(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);

  const preferredRef = useRef(preferred);
  preferredRef.current = preferred;

  // Cap on a narrow window, but never below the minimum.
  const cap = Math.max(
    SHELL_SIDEBAR_MIN_WIDTH,
    Math.min(SHELL_SIDEBAR_MAX_WIDTH, viewportWidth - MAIN_AREA_RESERVE),
  );
  const width = clamp(preferred, SHELL_SIDEBAR_MIN_WIDTH, cap);
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
  // The handle can disappear while a drag is live (sidebar collapse, mini or
  // mobile switch), so `lostpointercapture` may never reach the window: end the
  // drag whenever the hook turns disabled.
  useEffect(() => {
    if (!enabled) endResizeRef.current?.();
  }, [enabled]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!enabled) return;
      // Primary left pointer only; secondary buttons and extra touches are ignored.
      if (event.button !== 0 || !event.isPrimary) return;
      // Never leave a previous drag running behind a new one.
      endResizeRef.current?.();
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startWidth = widthRef.current;
      // Stop the drag from also starting a text selection or focus ring.
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
        // CSS pixels only — no devicePixelRatio scaling. Clamp to the live
        // viewport cap so a narrow window cannot be over-run mid-drag.
        const next = clamp(
          Math.round(startWidth + (moveEvent.clientX - startX)),
          SHELL_SIDEBAR_MIN_WIDTH,
          viewportCap(),
        );
        // Keep the preference in step synchronously so an immediate pointerup
        // persists this final move even before React flushes the state update.
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
      // Only this drag's pointer ends it; blur below ends unconditionally.
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
      if (event.key === 'ArrowLeft') next = widthRef.current - KEYBOARD_STEP;
      else if (event.key === 'ArrowRight') next = widthRef.current + KEYBOARD_STEP;
      else if (event.key === 'Home') next = SHELL_SIDEBAR_MIN_WIDTH;
      else if (event.key === 'End') next = viewportCap();
      if (next === null) return;
      event.preventDefault();
      // Clamp to the live viewport cap, then keep the preference synchronous.
      const value = clamp(next, SHELL_SIDEBAR_MIN_WIDTH, viewportCap());
      preferredRef.current = value;
      setPreferred(value);
      writeStoredWidth(value);
    },
    [enabled],
  );

  const handleProps: HTMLAttributes<HTMLDivElement> = {
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': '调整侧边栏宽度',
    'aria-valuenow': Math.round(width),
    'aria-valuemin': SHELL_SIDEBAR_MIN_WIDTH,
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
      // The shell sidebar is pinned to the left edge, so its width is the boundary.
      left: `calc(var(--sidebar-width) - ${HANDLE_HALF_WIDTH}px)`,
      top: 'var(--titlebar-height)',
      height: 'calc(100svh - var(--titlebar-height) - var(--statusbar-height))',
    } as CSSProperties,
    onPointerDown,
    onKeyDown,
  };

  return { width, resizing, handleProps };
}
