// ── Blueprint Wren entity scene ──────────────────────────────────────
// PixiJS v8 game entity: warm-paper origami bird avatar for active
// TaskGraph instances. K3 Blueprint Wren — reads as a folded paper bird.

import type { RenderContainer, RenderGraphics, RenderSurface } from '../../../render';
import type { TaskGraphEntityDtoWithPresentation } from '../../../shared/taskgraph';

const WREN_W = 28;
const WREN_H = 22;
// K3 physical presentation: the authored pixel grid is rendered at a fixed
// 3x scale so the bird hits 84x66 crisp display pixels on Windows.
const WREN_SCALE = 3;
const WREN_DISPLAY_W = WREN_W * WREN_SCALE; // 84
const WREN_DISPLAY_H = WREN_H * WREN_SCALE; // 66

export { WREN_W, WREN_H, WREN_SCALE, WREN_DISPLAY_W, WREN_DISPLAY_H };

export interface WrenOutput {
  root: RenderContainer;
  clickRect: { x: number; y: number; width: number; height: number };
}

export interface WrenScene {
  readonly root: RenderContainer;
  update(dto: TaskGraphEntityDtoWithPresentation, nowMs: number): WrenOutput;
  destroy(): void;
}

interface WrenLayers {
  root: RenderContainer;
  body: RenderGraphics;
  staleMark: RenderGraphics;
}

export function createWrenScene(surface: RenderSurface): WrenScene {
  const root = surface.createContainer();
  // Scale the scene root exactly once: children stay authored in the 28x22
  // logical grid while the whole scene renders at 84x66 physical pixels.
  root.setScale(WREN_SCALE, WREN_SCALE);
  const body = surface.createGraphics();
  const staleMark = surface.createGraphics();

  root.add(body);
  root.add(staleMark);

  const layers: WrenLayers = { root, body, staleMark };
  let destroyed = false;

  surface.root.add(root);

  // The bird hit rect is the whole window-sized display area (the bird fills
  // it) in physical presentation pixels, not just the authored silhouette pixels
  const output: WrenOutput = { root, clickRect: { x: 0, y: 0, width: WREN_DISPLAY_W, height: WREN_DISPLAY_H } };

  function update(dto: TaskGraphEntityDtoWithPresentation, nowMs: number): WrenOutput {
    const state = dto.state;
    const isRunning = state === 'running';
    const isCreated = state === 'created';
    const isPaused = state === 'paused';
    const isStale = dto.presentation === 'stale';
    const isExiting = dto.presentation === 'exiting';
    const reducedMotion = dto.motion === 'reduced';
    // paused + failed node renders the error crack; otherwise manual hourglass
    const errorPaused = isPaused && dto.error_paused === true;
    const isDone = dto.terminal === 'done';
    const isCancelled = dto.terminal === 'cancelled';
    const cancelledNodeFailed = isCancelled && dto.terminal_reason === 'node_failed';

    // Wing animation driven by nowMs for running only. prefers-reduced-motion
    // cancels the loop and keeps the static up pose; created/paused fold the
    // wings (cycle 0) so the silhouette reads as 收翼.
    const wingCycle = isRunning && !reducedMotion ? Math.floor(nowMs / 400) % 2 : 0;

    // Lamplight Workshop colours: warm paper + dark ink
    const ink = '#2E2018';
    const paper = '#F5EBD4';
    const paperDark = '#E8DCC4';
    const accent = '#C44E3A';
    const slate = '#5B6E8A';
    const moss = '#7BA05B';
    const creaseColor = '#8B7D6B';
    const baseAlpha = isExiting ? 0.3 : isStale ? 0.65 : 1;
    const beakColor = '#B17D3E';

    const commands: import('../../../render').ShapeCommand[] = [
      // ── Ink silhouette outline (1px frame behind the paper body) ──
      // Defines the bird's edge so the shape still reads at 2x presentation.
      { kind: 'roundedRect', x: 2, y: 4, width: 24, height: 15, radius: 2, fill: ink, alpha: baseAlpha },

      // ── Body (folded paper shape) ──
      { kind: 'roundedRect', x: 3, y: 5, width: 22, height: 13, radius: 2, fill: paper, alpha: baseAlpha },

      // ── Wing (two-frame pose) ──
      // Wing fold line (always present)
      { kind: 'rect', x: 4, y: 8, width: 8, height: 2, fill: ink, alpha: baseAlpha },
      { kind: 'rect', x: 16, y: 8, width: 8, height: 2, fill: ink, alpha: baseAlpha },
      // Animated wing flap
      wingCycle === 0
        ? { kind: 'rect', x: 6, y: 6, width: 4, height: 3, fill: '#E8DCC4', alpha: baseAlpha } // up pose
        : { kind: 'rect', x: 6, y: 10, width: 4, height: 3, fill: '#E8DCC4', alpha: baseAlpha }, // down pose

      // ── Head (paper triangle) ──
      { kind: 'rect', x: 11, y: 2, width: 7, height: 4, fill: paper, alpha: baseAlpha },

      // ── Ink eye dot ──
      { kind: 'rect', x: 14, y: 3, width: 2, height: 2, fill: ink, alpha: baseAlpha },

      // ── Beak ──
      { kind: 'rect', x: 18, y: 4, width: 3, height: 2, fill: beakColor, alpha: baseAlpha },

      // ── Short tail tape with moving ink dot ──
      { kind: 'rect', x: 3, y: 15, width: 5, height: 4, fill: paperDark, alpha: baseAlpha },
      // Moving ink dot on tail
      { kind: 'rect', x: 4 + (wingCycle * 2), y: 16, width: 2, height: 2, fill: ink, alpha: baseAlpha },

      // ── Three-node DAG mark ──
      { kind: 'rect', x: 8, y: 10, width: 3, height: 3, fill: ink, alpha: baseAlpha },
      { kind: 'rect', x: 13, y: 10, width: 3, height: 3, fill: ink, alpha: baseAlpha },
      { kind: 'rect', x: 18, y: 10, width: 3, height: 3, fill: ink, alpha: baseAlpha },
      // Links between dots
      { kind: 'rect', x: 11, y: 11, width: 2, height: 1, fill: ink, alpha: baseAlpha },
      { kind: 'rect', x: 16, y: 11, width: 2, height: 1, fill: ink, alpha: baseAlpha },
    ];

    // Running lamp mark (moss/lamp light)
    if (isRunning) {
      commands.push(
        { kind: 'rect', x: 26, y: 2, width: 2, height: 4, fill: moss, alpha: 1 },
        { kind: 'rect', x: 26, y: 6, width: 2, height: 2, fill: '#5E7C46', alpha: 0.6 },
      );
    }

    // Created: small slate lamp (收翼 + slate 小灯)
    if (isCreated) {
      commands.push(
        { kind: 'rect', x: 26, y: 3, width: 2, height: 2, fill: slate, alpha: 1 },
      );
    }

    // Paused + failed node: terracotta crack instead of the hourglass
    if (errorPaused) {
      commands.push(
        { kind: 'rect', x: 8, y: 12, width: 5, height: 1, fill: accent, alpha: 0.9 },
        { kind: 'rect', x: 11, y: 13, width: 3, height: 1, fill: accent, alpha: 0.9 },
      );
    } else if (isPaused) {
      // Manual pause: slate hourglass
      commands.push(
        { kind: 'rect', x: 26, y: 2, width: 2, height: 6, fill: slate, alpha: 1 },
        { kind: 'rect', x: 25, y: 4, width: 4, height: 2, fill: slate, alpha: 1 },
      );
    }

    // Done: moss completion badge + one-time short celebration
    if (isDone) {
      const celebrate = reducedMotion ? 0 : Math.floor(nowMs / 200) % 2;
      commands.push(
        { kind: 'rect', x: 25, y: 2, width: 3, height: 3, fill: moss, alpha: 1 },
        { kind: 'rect', x: 25, y: 2 + (celebrate * 2), width: 3, height: 1, fill: paper, alpha: 0.8 },
      );
    }

    // Cancelled fold: terracotta for node_failed exit, slate otherwise
    if (isCancelled) {
      const foldColor = cancelledNodeFailed ? accent : slate;
      commands.push(
        { kind: 'rect', x: 24, y: 2, width: 4, height: 4, fill: foldColor, alpha: 1 },
        { kind: 'rect', x: 25, y: 3, width: 2, height: 2, fill: paper, alpha: 0.85 },
      );
    }

    // Stale crease (kept under exiting so both read together)
    if (isStale) {
      commands.push(
        { kind: 'rect', x: 0, y: 0, width: WREN_W, height: 1, fill: creaseColor, alpha: 0.4 },
        { kind: 'rect', x: 0, y: WREN_H - 1, width: WREN_W, height: 1, fill: creaseColor, alpha: 0.4 },
      );
    }

    // Exiting fold/fade
    if (isExiting) {
      commands.push(
        { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: WREN_W, y: 0 }, { x: WREN_W, y: WREN_H }, { x: 0, y: WREN_H }], fill: '#00000000' },
        { kind: 'rect', x: 0, y: 0, width: WREN_W, height: WREN_H, fill: '#000000', alpha: 0.15 },
      );
    }

    body.setCommands(commands);

    return output;
  }

  return {
    root,
    update,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try { surface.root.remove(root); } catch { /* best-effort */ }
      try { root.destroy(); } catch { /* best-effort */ }
    },
  };
}
