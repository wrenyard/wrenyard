import '../api/pet-api';
import { createRenderSurface } from '../../render';
import { HousePresenter, type HousePresenterOutput } from '../../features/house/presenter';
import { bindHouseDrag, createHousePassthroughController, bindActionButtons } from '../../features/house/interaction';
import type { BrowserDragController } from '../runtime/drag';
import { pointInRect } from '../runtime/passthrough';
import { readBrowserViewport } from '../viewport';
import { installStaticPreviewMode } from '../static-preview';
import { dismissBroadcastLocally } from '../../features/house/broadcast-dismiss';
import type { HouseRendererState } from '../../shared/entities';

async function main(): Promise<void> {
  const canvas = document.getElementById('scene') as HTMLCanvasElement | null;
  const closeButton = document.getElementById('broadcast-close') as HTMLButtonElement | null;
  const settingsButton = document.getElementById('settings-btn') as HTMLButtonElement | null;
  const statsButton = document.getElementById('stats-btn') as HTMLButtonElement | null;
  if (!canvas) throw new Error('missing #scene canvas');
  if (!closeButton) throw new Error('missing #broadcast-close button');
  if (!settingsButton) throw new Error('missing #settings-btn button');
  if (!statsButton) throw new Error('missing #stats-btn button');
  const staticPreview = installStaticPreviewMode(window.location.search, canvas, document);

  let latestHouseState: HouseRendererState | undefined;
  let applyHouseState: ((state: HouseRendererState, nowMs?: number) => void) | undefined;
  const disposeHouseUpdate = window.petApi.onHouseUpdate((state) => {
    latestHouseState = state;
    applyHouseState?.(state);
  });
  let houseUpdateSubscribed = true;
  const unsubscribeHouseUpdate = (): void => {
    if (!houseUpdateSubscribed) return;
    houseUpdateSubscribed = false;
    disposeHouseUpdate();
  };

  try {
    const viewport = readBrowserViewport(window);
    const surface = await createRenderSurface(canvas, { resolution: viewport.dpr });
    const presenter = new HousePresenter(surface);
    const passthrough = createHousePassthroughController(window.petApi);
    const disposables: Array<() => void> = [unsubscribeHouseUpdate];
    if (staticPreview) disposables.push(() => staticPreview.dispose());
    let drag: BrowserDragController | undefined;
    let hoverAuditInFlight = false;

    const syncOverlay = (output: HousePresenterOutput | undefined = presenter.getOutput()): void => {
      syncCloseTarget(closeButton, output?.closeRect);
      syncActionButton(settingsButton, output?.settingsBtn, output?.buttonsVisible);
      syncActionButton(statsButton, output?.statsBtn, output?.buttonsVisible);
      if (drag?.dragging) {
        passthrough.forceBlocking();
        return;
      }
      passthrough.set(output?.passthrough ?? true);
    };

    const hitTargets = document.getElementById('hit-targets');
    const disposeActionButtons = hitTargets ? bindActionButtons(hitTargets, window.petApi) : () => {};
    disposables.push(disposeActionButtons);

    applyHouseState = (state, nowMs = Date.now()): void => {
      const output = presenter.setState(state, nowMs);
      syncOverlay(output);
    };

    const renderAndSync = (nowMs = Date.now()): HousePresenterOutput | undefined => {
      const output = presenter.renderFrame(nowMs);
      syncOverlay(output);
      return output;
    };

    const resize = (nowMs = Date.now()): void => {
      const next = readBrowserViewport(window);
      const output = presenter.resize(next.cssWidth, next.cssHeight, next.dpr, nowMs);
      syncOverlay(output);
    };

    resize(staticPreview?.initNowMs);
    if (latestHouseState) {
      applyHouseState(latestHouseState, staticPreview?.initNowMs);
    }
    let scale = 3;
    try {
      const config = await window.petApi.getConfig();
      if (typeof config.scale === 'number') scale = config.scale;
    } catch {
      // Keep default scale when recovery/previews do not provide config.
    }
    if (!latestHouseState) {
      applyHouseState({ scale, houseSkin: 'classic', workers: [], queuedCount: 0 }, staticPreview?.initNowMs);
    }

    const dispose = (): void => {
      for (const disposeOne of disposables.splice(0)) disposeOne();
      passthrough.dispose();
      presenter.destroy();
      surface.destroy();
    };
    window.addEventListener('beforeunload', dispose, { once: true });
    window.addEventListener('unload', dispose, { once: true });

    if (staticPreview) {
      const initPointer = staticPreview.pointer ?? { x: -1, y: -1, inside: false };
      syncOverlay(presenter.setPointer(initPointer, staticPreview.initNowMs));
      syncOverlay(presenter.setDragging(staticPreview.dragging ?? false, staticPreview.initNowMs));
      renderAndSync(staticPreview.initNowMs);
      const output = renderAndSync(staticPreview.nowMs);
      staticPreview.markReady(output);
      return;
    }

    const onResize = (): void => resize();
    window.addEventListener('resize', onResize);
    disposables.push(() => window.removeEventListener('resize', onResize));

    const onMouseMove = (event: MouseEvent): void => {
      const output = presenter.setPointer({ x: event.clientX, y: event.clientY, inside: true });
      syncOverlay(output);
    };
    const onMouseLeave = (): void => {
      if (drag?.dragging) return;
      const output = presenter.setPointer({ x: -1, y: -1, inside: false });
      syncOverlay(output);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseleave', onMouseLeave);
    disposables.push(() => window.removeEventListener('mousemove', onMouseMove));
    disposables.push(() => window.removeEventListener('mouseleave', onMouseLeave));

    // Forwarded mouseleave can be lost while an ignored transparent window is
    // moved or its edge-aware carrier changes anchor. Reconcile only while
    // hover chrome is visible, using the main process' authoritative cursor.
    const hoverAuditTimer = window.setInterval(() => {
      const current = presenter.getOutput();
      if (hoverAuditInFlight || drag?.dragging || (!current?.stats && !current?.buttonsVisible)) return;
      hoverAuditInFlight = true;
      void window.petApi.getHouseCursorPoint()
        .then((point) => {
          if (!point || drag?.dragging) return;
          syncOverlay(presenter.setPointer(point));
        })
        .catch(() => {
          // Renderer recovery may briefly race the IPC owner; the next audit
          // converges without keeping hover chrome alive artificially.
        })
        .finally(() => {
          hoverAuditInFlight = false;
        });
    }, 100);
    disposables.push(() => window.clearInterval(hoverAuditTimer));

    const onCloseMouseDown = (event: MouseEvent): void => stopHitEvent(event);
    const onCloseClick = (event: MouseEvent): void => {
      stopHitEvent(event);
      const state = presenter.getState();
      if (!state) return;
      const dismissed = dismissBroadcastLocally(state);
      presenter.setState(dismissed.state);
      syncOverlay();
      window.petApi.dismissBroadcast(dismissed.id);
    };
    closeButton.addEventListener('mousedown', onCloseMouseDown);
    closeButton.addEventListener('click', onCloseClick);
    disposables.push(() => closeButton.removeEventListener('mousedown', onCloseMouseDown));
    disposables.push(() => closeButton.removeEventListener('click', onCloseClick));

    drag = bindHouseDrag(window.petApi, {
      win: window,
      doc: document,
      canStart: (event) => isOverHouseBody(event, renderAndSync()),
      onDraggingChange: (dragging) => {
        const output = presenter.setDragging(dragging);
        syncOverlay(output);
      },
    });
    disposables.push(() => drag?.dispose());

    presenter.start(syncOverlay);
  } catch (error) {
    unsubscribeHouseUpdate();
    staticPreview?.dispose();
    throw error;
  }
}

function syncCloseTarget(button: HTMLButtonElement, rect: HousePresenterOutput['closeRect']): void {
  if (!rect) {
    button.style.display = 'none';
    return;
  }
  button.style.display = 'block';
  button.style.left = `${Math.round(rect.x)}px`;
  button.style.top = `${Math.round(rect.y)}px`;
  button.style.width = `${Math.round(rect.width)}px`;
  button.style.height = `${Math.round(rect.height)}px`;
}

function syncActionButton(button: HTMLButtonElement, rect: HousePresenterOutput['settingsBtn'] | undefined, visible: boolean | undefined): void {
  if (!rect || !visible) {
    button.style.display = 'none';
    return;
  }
  button.style.display = 'block';
  button.style.left = `${Math.round(rect.x)}px`;
  button.style.top = `${Math.round(rect.y)}px`;
  button.style.width = `${Math.round(rect.width)}px`;
  button.style.height = `${Math.round(rect.height)}px`;
}

function stopHitEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function isOverHouseBody(event: MouseEvent, output: HousePresenterOutput | undefined): boolean {
  return !!output?.houseRect && pointInRect(
    { x: event.clientX, y: event.clientY, inside: true },
    output.houseRect,
  );
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  void main();
}
