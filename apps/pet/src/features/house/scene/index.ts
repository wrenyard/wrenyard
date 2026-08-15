import type {
  RenderContainer,
  RenderGraphics,
  RenderPixel,
  RenderSurface,
} from '../../../render';
import { PixelBuilder } from '../../../render';
import type { HouseRendererState } from '../../../shared/entities';
import {
  updateHouseSprite,
  HOUSE_PX_H,
  HOUSE_PX_W,
} from './house-sprite';
import {
  collectHitRects,
  hitTargetAt,
  isPassthrough,
  pointInRect,
  rightEdgeButtonRects,
  type HouseHitRect,
  type HouseHitTarget,
  type HouseRect,
  type PointerInput,
} from './hit-regions';
import {
  createStatusLabel,
  updateStatusLabel,
  type StatusLabelLayout,
  type StatusLabelNode,
} from './status-label';
import {
  createBroadcastCard,
  updateBroadcastCard,
  type BroadcastCardNode,
  type BroadcastLayout,
} from './broadcast-card';
import {
  createStatsCard,
  updateStatsCard,
  type StatsCardLayout,
  type StatsCardNode,
} from './stats-card';

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
  closeRect?: HouseRect;
  hitRects: HouseHitRect[];
  passthrough: boolean;
  target?: HouseHitTarget;
  bodyTargeted: boolean;
  closeTargeted: boolean;
  status?: StatusLabelLayout;
  broadcast?: BroadcastLayout;
  stats?: StatsCardLayout;
  buttonsVisible: boolean;
  settingsBtn?: HouseRect;
  statsBtn?: HouseRect;
  tipsCardRect?: HouseRect;
}

export interface HouseScene {
  readonly root: RenderContainer;
  update(
    state: HouseRendererState,
    pointer: PointerInput,
    dragging: boolean,
    viewport: HouseNodeViewport,
    nowMs: number,
    buttonsVisible?: boolean,
  ): HouseNodeOutput;
  destroy(): void;
}

interface HouseNodeLayers {
  root: RenderContainer;
  sprite: RenderPixel;
  status: StatusLabelNode;
  broadcast: BroadcastCardNode;
  stats: StatsCardNode;
  settingsBtn: RenderGraphics;
  statsBtn: RenderGraphics;
  x: number;
  y: number;
  scale: number;
}

export function createHouseScene(
  surface: RenderSurface,
  state: HouseRendererState,
  pointer: PointerInput,
  dragging: boolean,
  viewport: HouseNodeViewport,
  nowMs = 0,
): HouseScene {
  const root = surface.createContainer();
  const sprite = surface.createPixel(new PixelBuilder(HOUSE_PX_W, HOUSE_PX_H).build());
  const statusContainer = surface.createContainer();
  const broadcastContainer = surface.createContainer();
  const statsContainer = surface.createContainer();
  const settingsBtn = surface.createGraphics();
  const statsBtn = surface.createGraphics();

  root.add(sprite);
  root.add(statusContainer);
  root.add(broadcastContainer);
  root.add(statsContainer);
  root.add(settingsBtn);
  root.add(statsBtn);

  const layers: HouseNodeLayers = {
    root,
    sprite,
    status: createStatusLabel(statusContainer, surface),
    broadcast: createBroadcastCard(broadcastContainer, surface),
    stats: createStatsCard(statsContainer, surface),
    settingsBtn,
    statsBtn,
    x: 0,
    y: 0,
    scale: viewport.scale,
  };

  const initial = baseOutput(root, viewport, pointer, dragging);
  let output = updateHouseSceneOutput(initial, layers, state, pointer, dragging, viewport, nowMs, false);
  let destroyed = false;

  surface.root.add(root);

  return {
    root,
    update(nextState, nextPointer, nextDragging, nextViewport, nextNowMs, buttonsVisible) {
      output = updateHouseSceneOutput(output, layers, nextState, nextPointer, nextDragging, nextViewport, nextNowMs, buttonsVisible ?? false);
      return output;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      safeRemove(surface, root);
      safeDestroy(root);
    },
  };
}

function updateHouseSceneOutput(
  node: HouseNodeOutput,
  layers: HouseNodeLayers,
  state: HouseRendererState,
  pointer: PointerInput,
  dragging: boolean,
  viewport: HouseNodeViewport,
  nowMs: number,
  buttonsVisible: boolean,
): HouseNodeOutput {
  const logical = houseLogicalPosition(viewport, state.placement);
  layers.x = logical.x;
  layers.y = logical.y;
  layers.scale = viewport.scale;
  const houseRect = physicalHouseRect(logical.x, logical.y, viewport.scale);
  const viewportWidth = Math.round(viewport.width * viewport.scale);
  const viewportHeight = Math.round(viewport.height * viewport.scale);

  // Compute running state and tiers
  const runningWorkerCount = state.workers.filter((w) => w.phase === 'working').length;
  const isRunning = runningWorkerCount > 0;
  const totalTokens = state.dailyStats?.totalTokens ?? 0;
  const dispatchCount = state.dailyStats?.dispatchCount ?? 0;

  updateHouseSprite(
    layers.sprite,
    logical.x,
    logical.y,
    viewport.scale,
    isRunning,
    runningWorkerCount,
    totalTokens,
    dispatchCount,
    state.houseSkin,
  );

  const status = updateStatusLabel(layers.status, {
    workers: state.workers ?? [],
    queuedCount: state.queuedCount ?? 0,
    dailyStats: state.dailyStats,
    pointer,
    houseRect,
    viewportWidth,
    viewportHeight,
  });
  const broadcast = updateBroadcastCard(layers.broadcast, {
    broadcast: state.broadcast,
    houseRect,
    viewportWidth,
    viewportHeight,
    nowMs,
  });
  const stats = updateStatsCard(layers.stats, {
    dailyStats: state.dailyStats,
    dailyStatsUnavailable: state.dailyStatsUnavailable,
    runningWorkerCount,
    queuedCount: state.queuedCount,
    taskgraphCount: state.taskgraphCount,
    activityStale: state.activityStale,
    quotaTips: state.quotaTips,
    pointer,
    dragging,
    houseRect,
    viewportWidth,
    viewportHeight,
  });

  // Button rects: visible when hover-retained, hidden during drag
  const btnRects = buttonsVisible && !dragging ? rightEdgeButtonRects(houseRect, viewportWidth) : undefined;
  if (btnRects) {
    layers.settingsBtn.setCommands(buttonCommands(btnRects.settings, '#F7EFD8', '#2E2018', 'settings'));
    layers.settingsBtn.setVisible(true);
    layers.statsBtn.setCommands(buttonCommands(btnRects.stats, '#F7EFD8', '#2E2018', 'stats'));
    layers.statsBtn.setVisible(true);
  } else {
    layers.settingsBtn.setCommands([]);
    layers.settingsBtn.setVisible(false);
    layers.statsBtn.setCommands([]);
    layers.statsBtn.setVisible(false);
  }

  // Tips card rect for hover retention
  const tipsCardR = stats ? { x: stats.x, y: stats.y, width: stats.width, height: stats.height } : undefined;

  const closeRect = broadcast?.closeRect;
  const hitRects = collectHitRects({
    houseRect,
    closeRect,
    dragging,
    buttonsVisible: buttonsVisible && !dragging,
    settingsBtn: btnRects?.settings,
    statsBtn: btnRects?.stats,
    tipsCard: tipsCardR,
  });
  const target = hitTargetAt(hitRects, pointer);
  return {
    root: node.root,
    houseRect,
    closeRect,
    hitRects,
    passthrough: isPassthrough({ hitRects, pointer, dragging }),
    target,
    bodyTargeted: target === 'house',
    closeTargeted: target === 'broadcast-close',
    status,
    broadcast,
    stats,
    buttonsVisible: buttonsVisible && !dragging,
    settingsBtn: btnRects?.settings,
    statsBtn: btnRects?.stats,
    tipsCardRect: tipsCardR,
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

function baseOutput(
  root: RenderContainer,
  viewport: HouseNodeViewport,
  pointer: PointerInput,
  dragging: boolean,
): HouseNodeOutput {
  const logical = houseLogicalPosition(viewport);
  const houseRect = physicalHouseRect(logical.x, logical.y, viewport.scale);
  const hitRects = collectHitRects({ houseRect, dragging });
  const target = hitTargetAt(hitRects, pointer);
  return {
    root,
    houseRect,
    hitRects,
    passthrough: isPassthrough({ hitRects, pointer, dragging }),
    target,
    bodyTargeted: target === 'house',
    closeTargeted: target === 'broadcast-close',
    buttonsVisible: false,
  };
}

function buttonCommands(rect: HouseRect, fill: string, border: string, kind: 'settings' | 'stats'): import('../../../render').ShapeCommand[] {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  const iconColor = '#2E2018';
  const cmds: import('../../../render').ShapeCommand[] = [
    {
      kind: 'roundedRect',
      x,
      y,
      width: w,
      height: h,
      radius: 3,
      fill: '#F7EFD8',
      alpha: 0.92,
    },
    {
      kind: 'roundedRect',
      x: x + 1,
      y: y + 1,
      width: w - 2,
      height: h - 2,
      radius: 2,
      fill: '#2E2018',
      alpha: 0.08,
    },
  ];
  if (kind === 'settings') {
    // Pixel-art gear/cog with a center hole
    cmds.push(
      { kind: 'rect', x: x + 3, y: y + 3, width: 14, height: 3, fill: iconColor },
      { kind: 'rect', x: x + 3, y: y + 14, width: 14, height: 3, fill: iconColor },
      { kind: 'rect', x: x + 3, y: y + 6, width: 3, height: 8, fill: iconColor },
      { kind: 'rect', x: x + 14, y: y + 6, width: 3, height: 8, fill: iconColor },
      { kind: 'rect', x: x + 6, y: y + 1, width: 2, height: 2, fill: iconColor },
      { kind: 'rect', x: x + 12, y: y + 1, width: 2, height: 2, fill: iconColor },
      { kind: 'rect', x: x + 6, y: y + 17, width: 2, height: 2, fill: iconColor },
      { kind: 'rect', x: x + 12, y: y + 17, width: 2, height: 2, fill: iconColor },
      { kind: 'rect', x: x + 1, y: y + 6, width: 2, height: 2, fill: iconColor },
      { kind: 'rect', x: x + 1, y: y + 12, width: 2, height: 2, fill: iconColor },
      { kind: 'rect', x: x + 17, y: y + 6, width: 2, height: 2, fill: iconColor },
      { kind: 'rect', x: x + 17, y: y + 12, width: 2, height: 2, fill: iconColor },
    );
  } else {
    // Pixel-art bar chart with three distinct ascending bars
    cmds.push(
      { kind: 'rect', x: x + 3, y: y + 15, width: 14, height: 2, fill: iconColor },
      { kind: 'rect', x: x + 4, y: y + 9, width: 3, height: 6, fill: iconColor },
      { kind: 'rect', x: x + 8, y: y + 6, width: 3, height: 9, fill: iconColor },
      { kind: 'rect', x: x + 12, y: y + 3, width: 3, height: 12, fill: iconColor },
    );
  }
  return cmds;
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

export {
  HOUSE_PX_H,
  HOUSE_PX_W,
  pointInRect,
};
export type { HouseHitRect, HouseHitTarget, HouseRect, PointerInput };
