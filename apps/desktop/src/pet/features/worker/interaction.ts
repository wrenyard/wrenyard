import type { PetApi } from '../../overlay/api/pet-api';
import {
  bindBodyDrag,
  type BrowserDragBindingOptions,
  type BrowserDragController,
} from '../../overlay/runtime/drag';
import {
  computePassthrough,
  type PassthroughController,
} from '../../overlay/runtime/passthrough';

export function bindWorkerDrag(
  api: Pick<PetApi, 'workerDragStart' | 'workerDragMove' | 'workerDragEnd'>,
  options: Omit<BrowserDragBindingOptions<string>, 'requireId' | 'onStart' | 'onMove' | 'onEnd'>,
): BrowserDragController {
  return bindBodyDrag({
    ...options,
    requireId: true,
    onStart: (id) => {
      if (id !== undefined) api.workerDragStart(id);
    },
    onMove: (id) => {
      if (id !== undefined) api.workerDragMove(id);
    },
    onEnd: (id) => {
      if (id !== undefined) api.workerDragEnd(id);
    },
  });
}

export function createWorkerPassthroughController(
  api: Pick<PetApi, 'setWorkerMousePassthrough'>,
  getWorkerId: () => string | undefined,
): PassthroughController {
  let lastWorkerId: string | undefined;
  let lastValue: boolean | undefined;
  let disposed = false;

  const emit = (passthrough: boolean): void => {
    if (disposed) return;
    const workerId = getWorkerId();
    if (!workerId) {
      lastWorkerId = undefined;
      lastValue = undefined;
      return;
    }
    if (lastWorkerId === workerId && lastValue === passthrough) return;
    lastWorkerId = workerId;
    lastValue = passthrough;
    api.setWorkerMousePassthrough(workerId, passthrough);
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
      lastWorkerId = undefined;
      lastValue = undefined;
    },
    dispose() {
      disposed = true;
      lastWorkerId = undefined;
      lastValue = undefined;
    },
  };
}
