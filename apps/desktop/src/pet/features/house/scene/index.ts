import type {
  PixelProgram,
  RenderContainer,
  RenderPixel,
  RenderSurface,
} from '../../../render';
import { PixelBuilder, pixelProgramCoversPoint } from '../../../render';
import type { HouseRendererState } from '../../../shared/entities';
import {
  buildHousePixelProgram,
  updateHouseSprite,
  HOUSE_PX_H,
  HOUSE_PX_W,
} from './house-sprite';
import { type HouseRect } from './hit-regions';

/**
 * The house scene is art-only now: a single Pixi pixel sprite plus the
 * geometry React needs to position its DOM chrome and to hit-test the sprite.
 * Every text/card surface moved to {@link HouseOverlay}.
 */
export interface HouseNodeViewport {
  /** Logical window width, before entity pixel scale is applied. */
  width: number;
  /** Logical window height, before entity pixel scale is applied. */
  height: number;
  /** Integer nearest-neighbor visual scale. */
  scale: number;
}

export interface HouseNodeOutput {
  root: RenderContainer;
  houseRect: HouseRect;
}

export interface HouseScene {
  readonly root: RenderContainer;
  update(
    state: HouseRendererState,
    viewport: HouseNodeViewport,
    nowMs: number,
  ): HouseNodeOutput;
  /** Alpha test against the authored sprite program at CSS-pixel coordinates. */
  hitTestScreen(x: number, y: number): boolean;
  destroy(): void;
}

interface HouseNodeLayers {
  root: RenderContainer;
  sprite: RenderPixel;
  hitProgram: PixelProgram;
  hitSkin: HouseRendererState['houseSkin'];
  logicalX: number;
  logicalY: number;
  scale: number;
}

export function createHouseScene(
  surface: RenderSurface,
  state: HouseRendererState,
  viewport: HouseNodeViewport,
  nowMs = 0,
): HouseScene {
  const root = surface.createContainer();
  const sprite = surface.createPixel(new PixelBuilder(HOUSE_PX_W, HOUSE_PX_H).build());
  root.add(sprite);

  const initial = houseLogicalPosition(viewport, state.placement);
  const layers: HouseNodeLayers = {
    root,
    sprite,
    hitProgram: buildHousePixelProgram(state.houseSkin),
    hitSkin: state.houseSkin,
    logicalX: initial.x,
    logicalY: initial.y,
    scale: viewport.scale,
  };

  surface.root.add(root);
  let destroyed = false;

  const paint = (nextState: HouseRendererState, nextViewport: HouseNodeViewport): HouseNodeOutput => {
    const logical = houseLogicalPosition(nextViewport, nextState.placement);
    layers.logicalX = logical.x;
    layers.logicalY = logical.y;
    layers.scale = nextViewport.scale;
    if (layers.hitSkin !== nextState.houseSkin) {
      layers.hitProgram = buildHousePixelProgram(nextState.houseSkin);
      layers.hitSkin = nextState.houseSkin;
    }

    const runningWorkerCount = nextState.workers.filter((worker) => worker.phase === 'working').length;
    updateHouseSprite(
      layers.sprite,
      logical.x,
      logical.y,
      nextViewport.scale,
      runningWorkerCount > 0,
      runningWorkerCount,
      nextState.dailyStats?.totalTokens ?? 0,
      nextState.dailyStats?.dispatchCount ?? 0,
      nextState.houseSkin,
    );

    return {
      root,
      houseRect: physicalHouseRect(logical.x, logical.y, nextViewport.scale),
    };
  };

  return {
    root,
    update(nextState, nextViewport) {
      return paint(nextState, nextViewport);
    },
    hitTestScreen(x: number, y: number): boolean {
      const scale = layers.scale;
      if (!Number.isFinite(scale) || scale <= 0) return false;
      const originX = Math.round(layers.logicalX * scale);
      const originY = Math.round(layers.logicalY * scale);
      return pixelProgramCoversPoint(
        layers.hitProgram,
        Math.floor((x - originX) / scale),
        Math.floor((y - originY) / scale),
      );
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      safeRemove(surface, root);
      safeDestroy(root);
    },
  };
}

export function houseLogicalPosition(
  viewport: HouseNodeViewport,
  placement?: { x: number; y: number },
): { x: number; y: number } {
  if (placement && Number.isFinite(placement.x) && Number.isFinite(placement.y)) {
    return {
      x: clamp(placement.x / viewport.scale, 0, Math.max(0, viewport.width - HOUSE_PX_W)),
      y: clamp(placement.y / viewport.scale, 0, Math.max(0, viewport.height - HOUSE_PX_H)),
    };
  }
  return {
    x: Math.max(0, Math.floor((viewport.width - HOUSE_PX_W) / 2)),
    y: Math.max(0, viewport.height - HOUSE_PX_H),
  };
}

export function physicalHouseRect(x: number, y: number, scale: number): HouseRect {
  return {
    x: Math.round(x * scale),
    y: Math.round(y * scale),
    width: HOUSE_PX_W * scale,
    height: HOUSE_PX_H * scale,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function safeRemove(surface: RenderSurface, root: RenderContainer): void {
  try {
    surface.root.remove(root);
  } catch {
    // Surface may already be gone during page unload.
  }
}

function safeDestroy(root: RenderContainer): void {
  try {
    root.destroy();
  } catch {
    // Destroy remains best-effort during unload.
  }
}

export { HOUSE_PX_H, HOUSE_PX_W };
export type { HouseRect };
