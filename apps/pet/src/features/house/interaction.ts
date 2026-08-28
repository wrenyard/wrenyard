import type { PetApi } from '../../overlay/api/pet-api';
import {
  bindBodyDrag,
  type BrowserDragBindingOptions,
  type BrowserDragController,
} from '../../overlay/runtime/drag';
import {
  createSenderMemoPassthroughController,
  type PassthroughController,
} from '../../overlay/runtime/passthrough';

export function bindHouseDrag(
  api: Pick<PetApi, 'houseDragStart' | 'houseDragMove' | 'houseDragEnd'>,
  options: Omit<BrowserDragBindingOptions<void>, 'excludeSelector' | 'onStart' | 'onMove' | 'onEnd'>,
): BrowserDragController {
  return bindBodyDrag({
    ...options,
    excludeSelector: '.sticky-hit',
    onStart: () => api.houseDragStart(),
    onMove: () => api.houseDragMove(),
    onEnd: () => api.houseDragEnd(),
  });
}

export function createHousePassthroughController(
  api: Pick<PetApi, 'setHouseMousePassthrough'>,
): PassthroughController {
  return createSenderMemoPassthroughController((passthrough) => {
    api.setHouseMousePassthrough(passthrough);
  });
}
