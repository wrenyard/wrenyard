import type { RenderSurface } from '../../render';
import {
  createWorkerScene,
  type WorkerNodeOutput,
  type WorkerNodeState,
  type WorkerNodeViewport,
  type WorkerScene,
} from './scene';
import { hitTest } from './scene/hit-regions';
import type { WorkerRendererState } from '../../shared/entities';

export interface WorkerPresenterOutput extends WorkerNodeOutput {}

export interface WorkerPresenterViewport {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

/**
 * Pixi-backed worker presenter. It owns the mascot sprite canvas and exposes
 * the footline hit region; the React {@link WorkerOverlay} renders the bubble,
 * label and tool cue from the same state.
 */
export class WorkerPresenter {
  private readonly surface: RenderSurface;
  private state: WorkerRendererState | undefined;
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
      this.scene = createWorkerScene(this.surface, visualState, viewport);
    }
    this.output = this.scene.update(visualState, viewport, nowMs);
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

  /** Whether the CSS-pixel point falls in the sprite footline hit region. */
  hitTest(x: number, y: number): boolean {
    const region = this.output?.hitRegion;
    return region !== undefined && hitTest(region, { x, y });
  }

  private entityViewport(scale: number): WorkerNodeViewport {
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

export type WorkerLabelKind = 'age' | 'task';

/** Age label text ("Ns"/"Nm") shown to the right of the sprite footline. */
export function formatWorkerAge(startedAt: number, nowMs: number): string {
  const ageSec = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  if (ageSec < 60) return `${ageSec}s`;
  return `${Math.min(99, Math.floor(ageSec / 60))}m`;
}

/**
 * Label shown by the React {@link WorkerOverlay}: the task name while hovered,
 * otherwise the worker age.
 */
export function resolveWorkerLabelText(input: {
  hovering: boolean;
  taskName?: string;
  taskLabel?: string;
  taskId?: string;
  startedAt: number;
  nowMs: number;
}): { kind: WorkerLabelKind; text: string } {
  const hoverLabel = input.taskName || input.taskLabel || input.taskId || '';
  if (input.hovering && hoverLabel.length > 0) {
    return { kind: 'task', text: hoverLabel };
  }
  return { kind: 'age', text: formatWorkerAge(input.startedAt, input.nowMs) };
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
