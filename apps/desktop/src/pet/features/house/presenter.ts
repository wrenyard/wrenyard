import type { RenderSurface } from '../../render';
import {
  createHouseScene,
  type HouseNodeOutput,
  type HouseNodeViewport,
  type HouseScene,
} from './scene';
import type { HouseRendererState } from '../../shared/entities';

export interface HousePresenterOutput extends HouseNodeOutput {}

export interface HousePresenterViewport {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

/**
 * Pixi-backed house presenter. It owns the sprite canvas and exposes the
 * house rectangle plus a sprite alpha hit test; all text/cards are rendered by
 * the React {@link HouseOverlay} from the same state.
 */
export class HousePresenter {
  private readonly surface: RenderSurface;
  private state: HouseRendererState | undefined;
  private viewport: HousePresenterViewport = { cssWidth: 1, cssHeight: 1, dpr: 1 };
  private scene: HouseScene | undefined;
  private output: HousePresenterOutput | undefined;
  private tickerUnsubscribe: (() => void) | undefined;
  private frameListener: ((output: HousePresenterOutput | undefined) => void) | undefined;
  private destroyed = false;

  constructor(surface: RenderSurface) {
    this.surface = surface;
  }

  setState(state: HouseRendererState, nowMs = Date.now()): HousePresenterOutput | undefined {
    this.assertAlive();
    this.state = state;
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

    if (!this.scene) {
      this.scene = createHouseScene(this.surface, this.state, viewport, nowMs);
    }
    this.output = this.scene.update(this.state, viewport, nowMs);

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
  }

  getOutput(): HousePresenterOutput | undefined {
    return this.output;
  }

  getState(): HouseRendererState | undefined {
    return this.state;
  }

  /** Alpha test against the current house sprite program (CSS pixels). */
  hitTest(x: number, y: number): boolean {
    return this.scene?.hitTestScreen(x, y) ?? false;
  }

  private entityViewport(scale: number): HouseNodeViewport {
    return {
      width: Math.max(1, this.viewport.cssWidth / scale),
      height: Math.max(1, this.viewport.cssHeight / scale),
      scale,
    };
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error('house presenter has been destroyed');
    }
  }
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

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const safe = Math.max(0, Math.floor(value));
  if (safe >= 1_000_000) return `${Math.round(safe / 1_000_000)} mtok`;
  if (safe >= 1_000) return `${Math.round(safe / 1_000)} ktok`;
  if (safe > 0) return '<1 ktok';
  return '0 ktok';
}

/**
 * Two-line Lamplight summary shared by the house hover card: the Chinese
 * activity line from the one snapshot plus the token/state line. When
 * `activityStale` the counts are kept and the second line is 信号暂失.
 */
export function buildSummaryLines(input: {
  runningWorkerCount: number;
  queuedCount: number;
  taskgraphCount?: number;
  activityStale?: boolean;
  dailyStats?: { dispatchCount: number; totalTokens: number; inputTokens: number; outputTokens: number; source: string };
  dailyStatsUnavailable?: boolean;
}): string[] {
  const lines: string[] = [];
  let line1 = `${input.runningWorkerCount} 个任务运行中`;
  if (input.queuedCount > 0) line1 += ` · ${input.queuedCount} 个排队`;
  if (input.taskgraphCount !== undefined && input.taskgraphCount > 0) line1 += ` · ${input.taskgraphCount} 张图纸`;
  lines.push(line1);
  if (input.activityStale) {
    lines.push('信号暂失');
  } else if (input.dailyStats?.source === 'sqlite') {
    const s = input.dailyStats;
    lines.push(`in ${formatCount(s.inputTokens)} · out ${formatCount(s.outputTokens)} · total ${formatCount(s.totalTokens)}`);
  } else if (input.dailyStatsUnavailable) {
    lines.push('stats unavailable');
  } else {
    lines.push(`total ${formatCount(input.dailyStats?.totalTokens ?? 0)}`);
  }
  return lines;
}
