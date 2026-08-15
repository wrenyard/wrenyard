import type { RenderSurface } from '../../render';
import {
  createHouseScene,
  type HouseNodeOutput,
  type HouseScene,
  type PointerInput,
} from './scene';
import type { HouseRendererState } from '../../shared/entities';

export const HOVER_LEAVE_DELAY_MS = 200;

export interface HousePresenterOutput extends HouseNodeOutput {}

export interface HousePresenterViewport {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

export class HousePresenter {
  private readonly surface: RenderSurface;
  private state: HouseRendererState | undefined;
  private pointer: PointerInput = { x: -1, y: -1, inside: false };
  private dragging = false;
  private viewport: HousePresenterViewport = { cssWidth: 1, cssHeight: 1, dpr: 1 };
  private scene: HouseScene | undefined;
  private output: HousePresenterOutput | undefined;
  private tickerUnsubscribe: (() => void) | undefined;
  private frameListener: ((output: HousePresenterOutput | undefined) => void) | undefined;
  private destroyed = false;
  private buttonsVisible = false;
  private hoverLeaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(surface: RenderSurface) {
    this.surface = surface;
  }

  setState(state: HouseRendererState, nowMs = Date.now()): HousePresenterOutput | undefined {
    this.assertAlive();
    this.state = state;
    return this.renderFrame(nowMs);
  }

  setPointer(pointer: PointerInput, nowMs = Date.now()): HousePresenterOutput | undefined {
    this.assertAlive();
    this.pointer = pointer;
    return this.renderFrame(nowMs);
  }

  setDragging(dragging: boolean, nowMs = Date.now()): HousePresenterOutput | undefined {
    this.assertAlive();
    this.dragging = dragging;
    if (dragging) {
      this.buttonsVisible = false;
      this.clearHoverLeaveTimer();
    }
    return this.renderFrame(nowMs);
  }

  resize(cssWidth: number, cssHeight: number, dpr: number, nowMs = Date.now()): HousePresenterOutput | undefined {
    this.assertAlive();
    this.viewport = { cssWidth, cssHeight, dpr };
    this.surface.resize(cssWidth, cssHeight, dpr);
    return this.renderFrame(nowMs);
  }

  renderFrame(nowMs: number): HousePresenterOutput | undefined {
    this.assertAlive();
    if (!this.state) {
      this.surface.render();
      this.frameListener?.(undefined);
      return undefined;
    }

    const viewport = this.entityViewport(this.state.scale);

    // Determine buttonsVisible from current state
    this.updateButtonsVisibility(this.pointer, this.output);

    if (!this.scene) {
      this.scene = createHouseScene(this.surface, this.state, this.pointer, this.dragging, viewport, nowMs);
    }
    this.output = this.scene.update(this.state, this.pointer, this.dragging, viewport, nowMs, this.buttonsVisible);

    this.surface.render();
    this.frameListener?.(this.output);
    return this.output;
  }

  start(onFrame?: (output: HousePresenterOutput | undefined) => void): void {
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
    this.clearHoverLeaveTimer();
  }

  getOutput(): HousePresenterOutput | undefined {
    return this.output;
  }

  getState(): HouseRendererState | undefined {
    return this.state;
  }

  private entityViewport(scale: number) {
    return {
      width: Math.max(1, this.viewport.cssWidth / scale),
      height: Math.max(1, this.viewport.cssHeight / scale),
      scale,
    };
  }

  private updateButtonsVisibility(pointer: PointerInput, output: HousePresenterOutput | undefined): void {
    if (this.dragging) {
      this.buttonsVisible = false;
      this.clearHoverLeaveTimer();
      return;
    }

    // Over house body, buttons, or tips card: show buttons, cancel leave timer
    if (output && pointer.inside) {
      const overActionable = output.hitRects.some((r) =>
        pointInRectInternal(pointer.x, pointer.y, r) && (r.target === 'house' || r.target === 'stats-btn' || r.target === 'settings-btn')
      );
      if (overActionable) {
        this.buttonsVisible = true;
        this.clearHoverLeaveTimer();
        return;
      }
    }

    // Not over actionable - start leave delay if not already started
    if (this.buttonsVisible && !this.hoverLeaveTimer) {
      this.hoverLeaveTimer = setTimeout(() => {
        this.hoverLeaveTimer = null;
        this.buttonsVisible = false;
      }, HOVER_LEAVE_DELAY_MS);
    }
  }

  private clearHoverLeaveTimer(): void {
    if (this.hoverLeaveTimer) {
      clearTimeout(this.hoverLeaveTimer);
      this.hoverLeaveTimer = null;
    }
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error('house presenter has been destroyed');
    }
  }
}

function pointInRectInternal(x: number, y: number, rect: { x: number; y: number; width: number; height: number }): boolean {
  return x >= rect.x &&
    x <= rect.x + rect.width &&
    y >= rect.y &&
    y <= rect.y + rect.height;
}

export function stateWithoutBroadcast(state: HouseRendererState): HouseRendererState {
  return {
    scale: state.scale,
    houseSkin: state.houseSkin,
    ...(state.placement ? { placement: { ...state.placement } } : {}),
    workers: state.workers,
    queuedCount: state.queuedCount,
    ...(state.activityStale ? { activityStale: true } : {}),
    ...(state.taskgraphCount !== undefined && state.taskgraphCount > 0 ? { taskgraphCount: state.taskgraphCount } : {}),
    ...(state.dailyStats ? { dailyStats: state.dailyStats } : {}),
    ...(state.quotaTips ? { quotaTips: state.quotaTips } : {}),
  };
}
