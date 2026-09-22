export interface PointerState {
  x: number;
  y: number;
  inside: boolean;
}

export interface HitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PassthroughInput {
  pointer: PointerState;
  hitRects: readonly HitRect[];
  dragging: boolean;
}

export interface PassthroughController {
  readonly value: boolean | undefined;
  set(passthrough: boolean): void;
  update(input: PassthroughInput): void;
  forceBlocking(): void;
  reset(): void;
  dispose(): void;
}

export function pointInRect(point: PointerState, rect: HitRect): boolean {
  return point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height;
}

export function computePassthrough(input: PassthroughInput): boolean {
  if (input.dragging) return false;
  if (!input.pointer.inside) return true;
  return input.hitRects.every((rect) => !pointInRect(input.pointer, rect));
}

export function createSenderMemoPassthroughController(send: (passthrough: boolean) => void): PassthroughController {
  let lastValue: boolean | undefined;
  let disposed = false;

  const emit = (passthrough: boolean): void => {
    if (disposed || lastValue === passthrough) return;
    lastValue = passthrough;
    send(passthrough);
  };

  return {
    get value() {
      return lastValue;
    },
    set: emit,
    update(input) {
      emit(computePassthrough(input));
    },
    forceBlocking() {
      emit(false);
    },
    reset() {
      lastValue = undefined;
    },
    dispose() {
      disposed = true;
      lastValue = undefined;
    },
  };
}
