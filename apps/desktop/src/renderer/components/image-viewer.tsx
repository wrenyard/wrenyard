/**
 * Generic zoomable / pannable image viewer.
 *
 * The image is fitted inside a bounded viewport. The wheel zooms about the
 * pointer, dragging pans once the pointer crosses a small dead zone, and the
 * zoom / reset buttons provide keyboard access to the same interaction. The
 * component only knows a source and an alt text; it carries no app vocabulary.
 *
 * Zoom and pan are direct manipulation: there is deliberately no transition or
 * easing, so the interaction needs no reduced-motion branch.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { cn } from 'cn';

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const ZOOM_STEP = 1.5;
/** Wheel delta to scale factor. Scrolling up (negative deltaY) zooms in. */
const WHEEL_SENSITIVITY = 0.0015;
/** Pointer travel in CSS pixels before a press starts panning. */
const DRAG_THRESHOLD_PX = 4;
const SCALE_EPSILON = 0.001;

interface View {
  scale: number;
  tx: number;
  ty: number;
}

const IDENTITY: View = { scale: 1, tx: 0, ty: 0 };

/** Layout metrics of the viewport and of the fitted, untransformed image box. */
interface Metrics {
  /** Viewport content size. */
  cw: number;
  ch: number;
  /** Fitted image size. */
  iw: number;
  ih: number;
  /** Fitted image offset inside the viewport. */
  il: number;
  it: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Keep the image inside the viewport: centre it on an axis where it is smaller
 * than the viewport, otherwise clamp the translation so its edges cannot be
 * dragged past the viewport edges.
 */
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

/** Scale about a viewport-local pointer position so the point under it stays put. */
function zoomAt(view: View, m: Metrics, px: number, py: number, nextScale: number): View {
  const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
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
}

export function ImageViewer({ src, alt, className }: ImageViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [view, setView] = useState<View>(IDENTITY);
  const viewRef = useRef(view);
  viewRef.current = view;
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
    return { cw: container.clientWidth, ch: container.clientHeight, iw, ih, il: img.offsetLeft, it: img.offsetTop };
  }, []);

  const reclamp = useCallback((): void => {
    const m = measure();
    if (m === undefined) return;
    setView((current) => clampView(current, m));
  }, [measure]);

  // Reopening the dialog remounts this component, and a new source resets here.
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
      const next = clamp(current.scale * Math.exp(-event.deltaY * unit * WHEEL_SENSITIVITY), MIN_SCALE, MAX_SCALE);
      if (next === current.scale) return;
      const rect = container.getBoundingClientRect();
      setView(zoomAt(current, m, event.clientX - rect.left, event.clientY - rect.top, next));
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => { container.removeEventListener('wheel', onWheel); };
  }, [measure]);

  // Keep the image inside the viewport when it is resized.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const observer = new ResizeObserver(() => { reclamp(); });
    observer.observe(container);
    window.addEventListener('resize', reclamp);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reclamp);
    };
  }, [reclamp]);

  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>): void => {
    if (view.scale <= MIN_SCALE + SCALE_EPSILON) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      baseTx: view.tx,
      baseTy: view.ty,
      active: false,
    };
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
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onLostCapture = (event: ReactPointerEvent<HTMLImageElement>): void => {
    if (dragRef.current?.id === event.pointerId) dragRef.current = undefined;
  };

  const zoomFromCenter = (factor: number): void => {
    const m = measure();
    if (m === undefined) return;
    setView((current) => zoomAt(current, m, m.cw / 2, m.ch / 2, current.scale * factor));
  };

  const reset = (): void => { setView(IDENTITY); };

  const atMin = view.scale <= MIN_SCALE + SCALE_EPSILON;
  const atMax = view.scale >= MAX_SCALE - SCALE_EPSILON;

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative h-[75vh] w-full touch-none overflow-hidden rounded-lg bg-muted/30 select-none',
        className,
      )}
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
        onLostPointerCapture={onLostCapture}
        className="absolute inset-0 m-auto max-h-full max-w-full cursor-grab select-none active:cursor-grabbing"
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`, transformOrigin: '0 0' }}
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-2xl bg-popover/90 p-0.5 shadow-sm ring-1 ring-foreground/5 backdrop-blur-sm">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="缩小"
            title="缩小"
            disabled={atMin}
            onClick={() => { zoomFromCenter(1 / ZOOM_STEP); }}
          >
            <ZoomOut />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="重置"
            title="重置"
            disabled={atMin && view.tx === 0 && view.ty === 0}
            onClick={reset}
          >
            <RotateCcw />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="放大"
            title="放大"
            disabled={atMax}
            onClick={() => { zoomFromCenter(ZOOM_STEP); }}
          >
            <ZoomIn />
          </Button>
        </div>
      </div>
    </div>
  );
}
