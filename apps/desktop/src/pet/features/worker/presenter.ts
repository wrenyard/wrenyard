import type { RenderSurface } from '../../render';
import {
  createWorkerScene,
  type WorkerNodeOutput,
  type WorkerNodeState,
  type WorkerScene,
} from './scene';
import type { WorkerRendererState } from '../../shared/entities';

export interface WorkerPresenterOutput extends WorkerNodeOutput {}

export interface WorkerPointerInput {
  x: number;
  y: number;
  inside: boolean;
}

export interface WorkerPresenterViewport {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

export class WorkerPresenter {
  private readonly surface: RenderSurface;
  private state: WorkerRendererState | undefined;
  private pointer: WorkerPointerInput = { x: -1, y: -1, inside: false };
  private dragging = false;
  private viewport: WorkerPresenterViewport = { cssWidth: 1, cssHeight: 1, dpr: 1 };
  private scene: WorkerScene | undefined;
  private output: WorkerPresenterOutput | undefined;
  private tickerUnsubscribe: (() => void) | undefined;
  private frameListener: ((output: WorkerPresenterOutput | undefined) => void) | undefined;
  private destroyed = false;

  constructor(surface: RenderSurface) {
    this.surface = surface;
  }

  setState(state: WorkerRendererState, nowMs = Date.now()): WorkerPresenterOutput | undefined {
    this.assertAlive();
    this.state = state;
    return this.renderFrame(nowMs);
  }

  setPointer(pointer: WorkerPointerInput, nowMs = Date.now()): WorkerPresenterOutput | undefined {
    this.assertAlive();
    this.pointer = pointer;
    return this.renderFrame(nowMs);
  }

  setDragging(dragging: boolean, nowMs = Date.now()): WorkerPresenterOutput | undefined {
    this.assertAlive();
    this.dragging = dragging;
    return this.renderFrame(nowMs);
  }

  resize(cssWidth: number, cssHeight: number, dpr: number, nowMs = Date.now()): WorkerPresenterOutput | undefined {
    this.assertAlive();
    this.viewport = { cssWidth, cssHeight, dpr };
    this.surface.resize(cssWidth, cssHeight, dpr);
    return this.renderFrame(nowMs);
  }

  renderFrame(nowMs: number): WorkerPresenterOutput | undefined {
    this.assertAlive();
    if (!this.state) {
      this.surface.render();
      this.frameListener?.(undefined);
      return undefined;
    }

    const viewport = this.entityViewport(this.state.scale);
    const visualState = workerVisualState(this.state);
    if (!this.scene) {
      this.scene = createWorkerScene(this.surface, visualState, this.pointer, this.dragging, viewport);
    }
    this.output = this.scene.update(visualState, this.pointer, this.dragging, viewport, nowMs);
    this.surface.render();
    this.frameListener?.(this.output);
    return this.output;
  }

  start(onFrame?: (output: WorkerPresenterOutput | undefined) => void): void {
    this.assertAlive();
    this.frameListener = onFrame;
    if (!this.tickerUnsubscribe) {
      this.tickerUnsubscribe = this.surface.ticker.add(() => {
        this.renderFrame(Date.now());
      });
    }
    this.surface.ticker.start();
  }

  stop(): void {
    if (this.destroyed) return;
    this.tickerUnsubscribe?.();
    this.tickerUnsubscribe = undefined;
    this.frameListener = undefined;
    this.surface.ticker.stop();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    this.scene?.destroy();
    this.scene = undefined;
    this.output = undefined;
  }

  getOutput(): WorkerPresenterOutput | undefined {
    return this.output;
  }

  getWorkerId(): string | undefined {
    return this.state?.worker.workerIdentityKey;
  }

  private entityViewport(scale: number) {
    return {
      width: Math.max(1, this.viewport.cssWidth / scale),
      height: Math.max(1, this.viewport.cssHeight / scale),
      scale,
    };
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error('worker presenter has been destroyed');
    }
  }
}

export function workerVisualState(state: WorkerRendererState): WorkerNodeState {
  const worker = state.worker;
  return {
    appearance: worker.appearance,
    phase: worker.phase,
    client: worker.client,
    sinceMs: worker.sinceMs,
    toolCount: worker.toolCount,
    lastToolTs: worker.lastToolTs,
    lastActivityTs: worker.lastActivityTs,
    lastContentTs: worker.lastContentTs,
    startedAt: worker.startedAt,
    taskLabel: worker.taskLabel,
    taskId: worker.taskId,
    taskName: worker.taskName,
    bubble: worker.bubble,
  };
}
