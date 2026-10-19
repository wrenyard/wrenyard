/**
 * Zoomable, pannable image surface of the lightbox.
 *
 * The image is fitted inside the viewport and never upscaled, so a small image
 * shows at its actual pixels. The wheel or a trackpad pinch zooms about the
 * pointer, a double click toggles between fit and 100% at the pointer, the keys
 * + / - / 0 zoom in, out and back to fit, and dragging pans once zoomed. A
 * small percentage chip shows for a second after each change.
 *
 * Zoom and pan are direct manipulation with no easing, so the interaction needs
 * no reduced-motion branch.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { cn } from 'cn';

const FIT_SCALE = 1;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.5;
/** Wheel delta to scale factor. Scrolling up (negative deltaY) zooms in. */
const WHEEL_SENSITIVITY = 0.0015;
/** Pointer travel in CSS pixels before a press starts panning. */
const DRAG_THRESHOLD_PX = 4;
const SCALE_EPSILON = 0.001;
/** How long the zoom percentage stays visible after a change. */
const CHIP_MS = 1_000;

interface View {
  scale: number;
  tx: number;
  ty: number;
}

const IDENTITY: View = { scale: FIT_SCALE, tx: 0, ty: 0 };

/** Layout metrics of the viewport and of the fitted, untransformed image box. */
interface Metrics {
  cw: number;
  ch: number;
  iw: number;
  ih: number;
  il: number;
  it: number;
  /** Scale at which one image pixel is one CSS pixel. */
  actual: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Centre the image on an axis where it is smaller than the viewport, else keep its edges inside. */
function clampView(view: View, m: Metrics): View {
  const scaledW = view.scale * m.iw;
  const scaledH = view.scale * m.ih;
  const tx = scaledW <= m.cw
    ? (m.cw - scaledW) / 2 - m.il
    : clamp(view.tx, m.cw - scaledW - m.il, -m.il);
  const ty = scaledH <= m.ch
    ? (m.ch - scaledH) / 2 - m.it
    : clamp(view.ty, m.ch - scaledH - m.it, -m.it);
  return { scale: view.scale, tx, ty };
}

/** Scale about a viewport-local point so the point under it stays put. */
function zoomAt(view: View, m: Metrics, px: number, py: number, nextScale: number): View {
  const scale = clamp(nextScale, FIT_SCALE, Math.max(MAX_SCALE, m.actual));
  if (scale === view.scale) return view;
  const a = px - m.il;
  const b = py - m.it;
  const ratio = scale / view.scale;
  return clampView({ scale, tx: a - ratio * (a - view.tx), ty: b - ratio * (b - view.ty) }, m);
}

export interface ImageViewerProps {
  src: string;
  alt: string;
  className?: string;
  /** Called on a plain click on the empty area around the image (not after a drag). */
  onBackdropClick?: () => void;
}

export function ImageViewer({ src, alt, className, onBackdropClick }: ImageViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [view, setView] = useState<View>(IDENTITY);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [chip, setChip] = useState<number | undefined>(undefined);
  const dragRef = useRef<
    { id: number; x: number; y: number; baseTx: number; baseTy: number; active: boolean } | undefined
  >(undefined);

  const measure = useCallback((): Metrics | undefined => {
    const container = containerRef.current;
    const img = imgRef.current;
    if (container === null || img === null) return undefined;
    const iw = img.offsetWidth;
    const ih = img.offsetHeight;
    if (iw === 0 || ih === 0) return undefined;
    return {
      cw: container.clientWidth,
      ch: container.clientHeight,
      iw,
      ih,
      il: img.offsetLeft,
      it: img.offsetTop,
      actual: img.naturalWidth > 0 ? img.naturalWidth / iw : FIT_SCALE,
    };
  }, []);

  /** Apply a view and flash its percentage relative to the actual pixels. */
  const apply = useCallback((next: View): void => {
    const m = measure();
    setView(next);
    if (m !== undefined && next.scale !== viewRef.current.scale) setChip(Math.round((next.scale / m.actual) * 100));
  }, [measure]);

  useEffect(() => {
    if (chip === undefined) return;
    const timer = window.setTimeout(() => setChip(undefined), CHIP_MS);
    return () => window.clearTimeout(timer);
  }, [chip]);

  const reclamp = useCallback((): void => {
    const m = measure();
    if (m === undefined) return;
    setView((current) => clampView(current, m));
  }, [measure]);

  useEffect(() => { setView(IDENTITY); }, [src]);

  // A passive wheel listener cannot call preventDefault, so attach a native one.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const current = viewRef.current;
      const m = measure();
      if (m === undefined) return;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 100 : 1;
      const rect = container.getBoundingClientRect();
      apply(zoomAt(current, m, event.clientX - rect.left, event.clientY - rect.top,
        current.scale * Math.exp(-event.deltaY * unit * WHEEL_SENSITIVITY)));
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => { container.removeEventListener('wheel', onWheel); };
  }, [measure, apply]);

  // + / - / 0 zoom about the centre.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const m = measure();
      if (m === undefined) return;
      const current = viewRef.current;
      if (event.key === '+' || event.key === '=') apply(zoomAt(current, m, m.cw / 2, m.ch / 2, current.scale * ZOOM_STEP));
      else if (event.key === '-') apply(zoomAt(current, m, m.cw / 2, m.ch / 2, current.scale / ZOOM_STEP));
      else if (event.key === '0') apply(clampView(IDENTITY, m));
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [measure, apply]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const observer = new ResizeObserver(() => { reclamp(); });
    observer.observe(container);
    return () => observer.disconnect();
  }, [reclamp]);

  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>): void => {
    if (view.scale <= FIT_SCALE + SCALE_EPSILON) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, baseTx: view.tx, baseTy: view.ty, active: false };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>): void => {
    const drag = dragRef.current;
    if (drag === undefined || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.active = true;
    }
    const m = measure();
    if (m === undefined) return;
    setView((current) => clampView({ scale: current.scale, tx: drag.baseTx + dx, ty: drag.baseTy + dy }, m));
  };

  const endDrag = (event: ReactPointerEvent<HTMLImageElement>): void => {
    const drag = dragRef.current;
    if (drag === undefined || drag.id !== event.pointerId) return;
    dragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  // Double click toggles fit and actual pixels at the pointer.
  const onDoubleClick = (event: ReactMouseEvent<HTMLImageElement>): void => {
    const m = measure();
    const container = containerRef.current;
    if (m === undefined || container === null) return;
    const rect = container.getBoundingClientRect();
    const atFit = view.scale <= FIT_SCALE + SCALE_EPSILON;
    apply(atFit && m.actual > FIT_SCALE + SCALE_EPSILON
      ? zoomAt(view, m, event.clientX - rect.left, event.clientY - rect.top, m.actual)
      : clampView(IDENTITY, m));
  };

  return (
    <div
      ref={containerRef}
      className={cn('relative size-full touch-none overflow-hidden select-none', className)}
      onClick={(event) => { if (event.target === event.currentTarget) onBackdropClick?.(); }}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        onDragStart={(event: ReactDragEvent<HTMLImageElement>) => { event.preventDefault(); }}
        onLoad={reclamp}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={(event) => { if (dragRef.current?.id === event.pointerId) dragRef.current = undefined; }}
        onDoubleClick={onDoubleClick}
        className={cn(
          'absolute inset-0 m-auto max-h-full max-w-full select-none',
          view.scale > FIT_SCALE + SCALE_EPSILON ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in',
        )}
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`, transformOrigin: '0 0' }}
      />
      {chip !== undefined && (
        <span className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-popover/90 px-2.5 py-1 text-xs tabular-nums shadow-sm ring-1 ring-foreground/5">
          {chip}%
        </span>
      )}
    </div>
  );
}
