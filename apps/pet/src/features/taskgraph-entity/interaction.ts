import {
  bindBodyDrag,
  type BrowserDragBindingOptions,
  type BrowserDragController,
} from '../../overlay/runtime/drag';

export interface WrenDragApi {
  entityDragStart(): void;
  entityDragMove(): void;
  entityDragEnd(): void;
}

export interface WrenDragController extends BrowserDragController {
  /** Consume the synthetic click emitted after a real pointer drag. */
  consumeOpenSuppression(): boolean;
}

export function bindWrenDrag(
  api: WrenDragApi,
  options: Omit<BrowserDragBindingOptions<void>, 'onStart' | 'onMove' | 'onEnd'>,
): WrenDragController {
  let moved = false;
  let suppressOpen = false;
  const drag = bindBodyDrag({
    ...options,
    onStart: () => {
      moved = false;
      suppressOpen = false;
      api.entityDragStart();
    },
    onMove: () => {
      moved = true;
      api.entityDragMove();
    },
    onEnd: () => {
      api.entityDragEnd();
      suppressOpen = moved;
      moved = false;
    },
  });

  return {
    get dragging() {
      return drag.dragging;
    },
    end: () => drag.end(),
    dispose: () => drag.dispose(),
    consumeOpenSuppression() {
      if (!suppressOpen) return false;
      suppressOpen = false;
      return true;
    },
  };
}
