export interface BrowserDragController {
  readonly dragging: boolean;
  end(): void;
  dispose(): void;
}

export interface BrowserDragBindingOptions<TId = void> {
  win: Window;
  doc: Document;
  excludeSelector?: string;
  requireId?: boolean;
  getId?: () => TId | undefined;
  canStart(event: MouseEvent): boolean;
  onStart(id: TId | undefined): void;
  onMove(id: TId | undefined): void;
  onEnd(id: TId | undefined): void;
  onDraggingChange?: (dragging: boolean) => void;
}

export function bindBodyDrag<TId = void>(options: BrowserDragBindingOptions<TId>): BrowserDragController {
  let dragging = false;
  let dragId: TId | undefined;
  let disposed = false;
  let rafId: number | undefined;

  const setCursor = (value: 'grab' | 'grabbing'): void => {
    options.doc.body.style.cursor = value;
  };

  const clearPendingMove = (): void => {
    if (rafId === undefined) return;
    options.win.cancelAnimationFrame(rafId);
    rafId = undefined;
  };

  const end = (): void => {
    if (!dragging) return;
    clearPendingMove();
    const endedId = dragId;
    dragging = false;
    dragId = undefined;
    setCursor('grab');
    options.onDraggingChange?.(false);
    options.onEnd(endedId);
  };

  const onMouseDown = (event: MouseEvent): void => {
    if (disposed || dragging) return;
    if (event.button !== 0) return;
    if (isExcludedTarget(event.target, options.excludeSelector)) return;
    if (!options.canStart(event)) return;

    const nextId = options.getId?.();
    if (options.requireId && nextId === undefined) return;

    dragging = true;
    dragId = nextId;
    setCursor('grabbing');
    options.onDraggingChange?.(true);
    options.onStart(dragId);
  };

  const onMouseMove = (): void => {
    if (disposed || !dragging || rafId !== undefined) return;
    rafId = options.win.requestAnimationFrame(() => {
      rafId = undefined;
      if (disposed || !dragging) return;
      options.onMove(dragId);
    });
  };

  options.win.addEventListener('mousedown', onMouseDown);
  options.win.addEventListener('mousemove', onMouseMove);
  options.win.addEventListener('mouseup', end);
  options.win.addEventListener('blur', end);
  setCursor('grab');

  return {
    get dragging() {
      return dragging;
    },
    end,
    dispose() {
      if (disposed) return;
      end();
      disposed = true;
      clearPendingMove();
      options.win.removeEventListener('mousedown', onMouseDown);
      options.win.removeEventListener('mousemove', onMouseMove);
      options.win.removeEventListener('mouseup', end);
      options.win.removeEventListener('blur', end);
    },
  };
}

function isExcludedTarget(target: EventTarget | null, selector: string | undefined): boolean {
  if (!selector || !(target instanceof Element)) return false;
  return target.closest(selector) !== null;
}
