/**
 * Tool-call cue rendering (PixiJS via src/render).
 *
 * Shows a tool/workshop-pickaxe icon plus a "× N" count near the worker's
 * right shoulder. Classic-voxel-miner uses the diamond pickaxe icon; every
 * other skin uses the tool icon. Flash alpha fades over ~2200ms unless hovered.
 *
 * Renders at physical CSS pixel scale — no container scaling. The icon rects
 * and text font size are all scaled by the viewport pixel scale so Pixi Text
 * textures are generated at full resolution.
 *
 * FU-002 / IU-002
 */

import type {
  RenderContainer,
  RenderGraphics,
  RenderSurface,
  RenderText,
  ShapeCommand,
} from '../../../render';
import type { Appearance, WorkerSkin } from '../../../shared/snapshot';
import { skinPalette, darkenColor, lightenColor } from './palette';
import { TOOL_FLASH_MS, toolFlashAlpha as timingToolFlashAlpha } from './timing';

export { TOOL_FLASH_MS };

export interface ToolCueState {
  toolCount: number;
  lastToolTs?: number;
  hovered: boolean;
  /** Worker skin id, to choose the icon. */
  skinId: WorkerSkin['id'];
  /** Tool color for the icon (defaults to palette tool color). */
  appearance?: Appearance;
}

export interface ToolCueNode {
  container: RenderContainer;
  graphics: RenderGraphics;
  text: RenderText;
}

/** Whether the tool cue should be visible this frame. */
export function toolCueVisible(
  toolCount: number,
  lastToolTs: number | undefined,
  hovered: boolean,
  nowMs: number,
): boolean {
  if (!(toolCount > 0)) return false;
  if (hovered) return true;
  if (lastToolTs === undefined) return false;
  return timingToolFlashAlpha(nowMs, lastToolTs) > 0;
}

/** Flash alpha: 1 while hovered; fading from 1.6× over the flash window. */
export function toolFlashAlpha(nowMs: number, lastToolTs: number | undefined, hovered = false): number {
  if (hovered) return 1;
  return timingToolFlashAlpha(nowMs, lastToolTs);
}

/** Build the tool-cue node (graphics + text) inside a container. */
export function createToolCue(
  container: RenderContainer,
  surface: RenderSurface,
): ToolCueNode {
  const graphics = surface.createGraphics();
  const text = surface.createText('', {
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: 5,
    fontWeight: 900,
    fill: '#FFFFFF',
    align: 'left',
    lineHeight: 7,
  });
  container.add(graphics);
  container.add(text);
  return { container, graphics, text };
}

/**
 * Update the tool-cue node from state; hides it when not visible.
 *
 * `gx` and `gy` are in CSS pixels. `scale` is the viewport pixel scale.
 * Icon rects use `scale` as their unit size (legacy 1px => `scale` CSS px).
 * Text uses `fontSize = 5 * scale` to match legacy 5px at the given scale.
 */
export function updateToolCue(
  node: ToolCueNode,
  state: ToolCueState,
  gx: number,
  gy: number,
  scale: number,
  nowMs: number,
): void {
  const visible = toolCueVisible(state.toolCount, state.lastToolTs, state.hovered, nowMs);
  if (!visible) {
    node.container.setVisible(false);
    return;
  }

  const alpha = toolFlashAlpha(nowMs, state.lastToolTs, state.hovered);
  const toolColor = state.appearance
    ? skinPalette(state.appearance).tool
    : '#1F3D6D';

  const isMiner = state.skinId === 'classic-voxel-miner';
  const s = scale; // pixel unit size
  const iconLogicalW = isMiner ? 12 : 8;
  const iconCSSW = iconLogicalW * s;
  const textBaselineCSSY = gy + (isMiner ? 6 : 4) * s;

  const commands: ShapeCommand[] = isMiner
    ? drawWorkshopPickaxeCSS(gx, gy, s)
    : drawPixelToolCSS(gx, gy, s, toolColor);

  node.graphics.setCommands(commands);

  const countText = `× ${Math.floor(state.toolCount)}`;
  node.text.setStyle({
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
    fontSize: 5 * s,
    fontWeight: 900,
    fill: toolColor,
    align: 'left',
    lineHeight: 7 * s,
  });
  node.text.setText(countText);
  const measured = node.text.measure();
  const textHeight = measured.height > 0 ? measured.height : 7 * s;
  node.text.setPosition(
    Math.round(gx + iconCSSW + 2 * s),
    Math.round(textBaselineCSSY - textHeight / 2),
  );

  node.container.setAlpha(alpha);
  node.container.setVisible(true);
}

// ─── Icon primitives (CSS pixel scale) ───────────────────────────────────

function drawPixelToolCSS(gx: number, gy: number, s: number, color: string): ShapeCommand[] {
  const outline = darkenColor(color, 0.52);
  const fill = lightenColor(color, 1.22);
  const shine = lightenColor(color, 1.55);
  const rect = (x: number, y: number, w: number, h: number, fill: string): ShapeCommand => ({
    kind: 'rect' as const,
    x: Math.round(gx + x * s),
    y: Math.round(gy + y * s),
    width: Math.round(w * s),
    height: Math.round(h * s),
    fill,
  });

  return [
    rect(3, 0, 2, 1, outline),
    rect(3, 7, 2, 1, outline),
    rect(0, 3, 1, 2, outline),
    rect(7, 3, 1, 2, outline),
    rect(1, 1, 2, 1, outline),
    rect(5, 1, 2, 1, outline),
    rect(1, 6, 2, 1, outline),
    rect(5, 6, 2, 1, outline),
    rect(3, 1, 2, 1, fill),
    rect(2, 2, 4, 1, fill),
    rect(1, 3, 2, 2, fill),
    rect(5, 3, 2, 2, fill),
    rect(2, 5, 4, 1, fill),
    rect(3, 6, 2, 1, fill),
    rect(3, 2, 2, 1, outline),
    rect(2, 3, 1, 2, outline),
    rect(5, 3, 1, 2, outline),
    rect(3, 5, 2, 1, outline),
    rect(2, 2, 1, 1, shine),
  ];
}

/**
 * Generic workshop pickaxe / hammer pixel tool using wood-and-ink palette.
 * Uses #2E2018, #5B3218, #8A5A2E, #B17D3E for handle/head and #FFC94D
 * for a highlight accent. 12px logical width (matching the old diamond
 * pickaxe footprint) so tool-cue timing, visibility, position and container
 * layout remain compatible.
 */
function drawWorkshopPickaxeCSS(gx: number, gy: number, s: number): ShapeCommand[] {
  const colors: Record<string, string> = {
    A: '#2E2018',
    B: '#5B3218',
    C: '#8A5A2E',
    D: '#B17D3E',
    E: '#FFC94D',
  };
  const rows = [
    '............',
    '..DDDDDD....',
    '..DCCCCDD...',
    '..DAAAACD...',
    '....AABACD..',
    '....ABBBACD.',
    '....ABBB.ACD',
    '....ABB..ABD',
    '.....A...A..',
    '......A....E',
    '.....A......',
    '............',
  ];
  const commands: ShapeCommand[] = [];
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const color = colors[rows[y][x]];
      if (color) {
        commands.push({
          kind: 'rect',
          x: Math.round(gx + x * s),
          y: Math.round(gy + y * s),
          width: Math.round(s),
          height: Math.round(s),
          fill: color,
        });
      }
    }
  }
  return commands;
}
