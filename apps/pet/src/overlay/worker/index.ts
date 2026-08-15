import '../api/pet-api';
import { createRenderSurface } from '../../render';
import { WorkerPresenter, type WorkerPresenterOutput } from '../../features/worker/presenter';
import { bindWorkerDrag, createWorkerPassthroughController } from '../../features/worker/interaction';
import type { BrowserDragController } from '../runtime/drag';
import { pointInRect } from '../runtime/passthrough';
import { readBrowserViewport } from '../viewport';
import { installStaticPreviewMode } from '../static-preview';
import type { WorkerRendererState } from '../../shared/entities';

async function main(): Promise<void> {
  const canvas = document.getElementById('scene') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('missing #scene canvas');
  const staticPreview = installStaticPreviewMode(window.location.search, canvas, document);

  let latestWorkerState: WorkerRendererState | undefined;
  let applyWorkerState: ((state: WorkerRendererState, nowMs?: number) => void) | undefined;
  const disposeWorkerUpdate = window.petApi.onWorkerUpdate((state) => {
    latestWorkerState = state;
    applyWorkerState?.(state);
  });
  let workerUpdateSubscribed = true;
  const unsubscribeWorkerUpdate = (): void => {
    if (!workerUpdateSubscribed) return;
    workerUpdateSubscribed = false;
    disposeWorkerUpdate();
  };

  try {
    const viewport = readBrowserViewport(window);
    const surface = await createRenderSurface(canvas, { resolution: viewport.dpr });
    const presenter = new WorkerPresenter(surface);
    const passthrough = createWorkerPassthroughController(window.petApi, () => presenter.getWorkerId());
    const disposables: Array<() => void> = [unsubscribeWorkerUpdate];
    if (staticPreview) disposables.push(() => staticPreview.dispose());
    let drag: BrowserDragController | undefined;

    const syncPassthrough = (output: WorkerPresenterOutput | undefined = presenter.getOutput()): void => {
      if (drag?.dragging) {
        passthrough.forceBlocking();
        return;
      }
      passthrough.set(output?.passthrough ?? true);
    };

    applyWorkerState = (state, nowMs = Date.now()): void => {
      const output = presenter.setState(state, nowMs);
      syncPassthrough(output);
    };

    const renderAndSync = (nowMs = Date.now()): WorkerPresenterOutput | undefined => {
      const output = presenter.renderFrame(nowMs);
      syncPassthrough(output);
      return output;
    };

    const resize = (nowMs = Date.now()): void => {
      const next = readBrowserViewport(window);
      const output = presenter.resize(next.cssWidth, next.cssHeight, next.dpr, nowMs);
      syncPassthrough(output);
    };

    resize(staticPreview?.initNowMs);
    if (latestWorkerState) {
      applyWorkerState(latestWorkerState, staticPreview?.initNowMs);
    }
    try {
      const config = await window.petApi.getConfig();
      if (typeof config.scale === 'number') {
        resize(staticPreview?.initNowMs);
      }
    } catch {
      // Missing config should not break renderer recovery or previews.
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
      syncPassthrough(presenter.setPointer(initPointer, staticPreview.initNowMs));
      syncPassthrough(presenter.setDragging(staticPreview.dragging ?? false, staticPreview.initNowMs));
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
      syncPassthrough(output);
    };
    const onMouseLeave = (): void => {
      if (drag?.dragging) return;
      const output = presenter.setPointer({ x: -1, y: -1, inside: false });
      syncPassthrough(output);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseleave', onMouseLeave);
    disposables.push(() => window.removeEventListener('mousemove', onMouseMove));
    disposables.push(() => window.removeEventListener('mouseleave', onMouseLeave));

    drag = bindWorkerDrag(window.petApi, {
      win: window,
      doc: document,
      getId: () => presenter.getWorkerId(),
      canStart: (event) => isOverWorker(event, renderAndSync()),
      onDraggingChange: (dragging) => {
        const output = presenter.setDragging(dragging);
        syncPassthrough(output);
      },
    });
    disposables.push(() => drag?.dispose());

    presenter.start(syncPassthrough);
  } catch (error) {
    unsubscribeWorkerUpdate();
    staticPreview?.dispose();
    throw error;
  }
}

function isOverWorker(event: MouseEvent, output: WorkerPresenterOutput | undefined): boolean {
  return !!output?.hitRegion && pointInRect(
    { x: event.clientX, y: event.clientY, inside: true },
    output.hitRegion,
  );
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  void main();
}

export {};
