import { useCallback, useEffect, useRef, useState } from 'react';
import type { HTMLAttributes, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { cn } from 'cn';

export const SIDE_PANEL_DEFAULT_WIDTH = 380;
export const SIDE_PANEL_MIN_WIDTH = 280;
export const SIDE_PANEL_MAIN_MIN_WIDTH = 360;
const HANDLE_HALF_WIDTH = 3;
const KEYBOARD_STEP = 16;
const STORAGE_KEY = 'wrenyard.shell.activity-panel-width';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(value: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Storage can be unavailable; resizing still works.
  }
}

export interface SidePanelResize {
  width: number;
  resizing: boolean;
  handleProps: HTMLAttributes<HTMLDivElement>;
}

export function useSidePanelResize(enabled: boolean, reservedWidth: number): SidePanelResize {
  const [preferred, setPreferred] = useState(() =>
    Math.max(SIDE_PANEL_MIN_WIDTH, readStoredWidth() ?? SIDE_PANEL_DEFAULT_WIDTH),
  );
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const preferredRef = useRef(preferred);
  preferredRef.current = preferred;
  const cap = Math.max(SIDE_PANEL_MIN_WIDTH, viewportWidth - reservedWidth - SIDE_PANEL_MAIN_MIN_WIDTH);
  const width = clamp(preferred, SIDE_PANEL_MIN_WIDTH, cap);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const endResizeRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endResizeRef.current?.(), []);
  useEffect(() => {
    if (!enabled) endResizeRef.current?.();
  }, [enabled]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || event.button !== 0 || !event.isPrimary) return;
    endResizeRef.current?.();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = widthRef.current;
    event.preventDefault();
    try { target.setPointerCapture(pointerId); } catch { /* Window listeners still drive resizing. */ }
    setResizing(true);
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    let done = false;
    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return;
      const next = clamp(
        Math.round(startWidth - (moveEvent.clientX - startX)),
        SIDE_PANEL_MIN_WIDTH,
        Math.max(SIDE_PANEL_MIN_WIDTH, window.innerWidth - reservedWidth - SIDE_PANEL_MAIN_MIN_WIDTH),
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
      try { target.releasePointerCapture(pointerId); } catch { /* Already released. */ }
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      setResizing(false);
      writeStoredWidth(preferredRef.current);
      endResizeRef.current = null;
    }
    function endFromPointer(pointerEvent: PointerEvent): void {
      if (pointerEvent.pointerId === pointerId) end();
    }

    endResizeRef.current = end;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endFromPointer);
    window.addEventListener('pointercancel', endFromPointer);
    window.addEventListener('lostpointercapture', endFromPointer);
    window.addEventListener('blur', end);
  }, [enabled, reservedWidth]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!enabled) return;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = widthRef.current + KEYBOARD_STEP;
    else if (event.key === 'ArrowRight') next = widthRef.current - KEYBOARD_STEP;
    else if (event.key === 'Home') next = SIDE_PANEL_MIN_WIDTH;
    else if (event.key === 'End') next = cap;
    if (next === null) return;
    event.preventDefault();
    const value = clamp(next, SIDE_PANEL_MIN_WIDTH, cap);
    preferredRef.current = value;
    setPreferred(value);
    writeStoredWidth(value);
  }, [enabled, cap]);

  const handleProps: HTMLAttributes<HTMLDivElement> = {
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': '调整侧边面板宽度',
    'aria-valuenow': Math.round(width),
    'aria-valuemin': SIDE_PANEL_MIN_WIDTH,
    'aria-valuemax': Math.round(cap),
    'aria-valuetext': `${Math.round(width)} 像素`,
    tabIndex: enabled ? 0 : -1,
    className: cn(
      'absolute z-10 w-1.5 touch-none select-none bg-transparent outline-none',
      'cursor-col-resize [-webkit-app-region:no-drag] [app-region:no-drag]',
      'hover:bg-sidebar-border/60 focus-visible:bg-sidebar-border/80',
      resizing && 'bg-sidebar-border/80',
    ),
    style: {
      left: -HANDLE_HALF_WIDTH,
      top: 0,
      bottom: 0,
    },
    onPointerDown,
    onKeyDown,
  };

  return { width, resizing, handleProps };
}
