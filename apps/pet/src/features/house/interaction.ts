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
    excludeSelector: '.sticky-hit, .action-btn',
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

export function bindActionButtons(
  container: HTMLElement,
  api: Pick<PetApi, 'openSettings' | 'openStats'>,
): () => void {
  const onSettingsClick = () => api.openSettings();
  const onStatsClick = () => api.openStats();

  // Use event delegation on the container
  const handler = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.dataset?.action === 'settings') {
      onSettingsClick();
    } else if (target.dataset?.action === 'stats') {
      onStatsClick();
    }
  };

  container.addEventListener('click', handler);
  return () => {
    container.removeEventListener('click', handler);
  };
}
