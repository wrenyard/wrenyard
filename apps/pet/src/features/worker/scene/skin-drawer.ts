/**
 * Live-only worker skin pixel drawing.
 *
 * Contains the 13 production worker skin draw routines plus shared helpers for
 * PixelBuilder rendering.
 *
 * Drawing targets a PixelBuilder (src/render); the `px` helper maps to filled
 * pixel rectangles. OffsetBuilder applies the sprite's local pixel offset to
 * every rect. Preview-only artwork, retired vector helpers, and inactive
 * tool-call popup art are intentionally absent.
 *
 * FU-002 / IU-001
 */

import type { Appearance } from '../../../shared/snapshot';
import type { Phase } from '../../../shared/snapshot';
import type { PixelBuilder } from '../../../render';
import { skinPalette, voxelMinerPalette, parseColorAlpha } from './palette';

// ─── Pixel-builder bridge ──────────────────────────────────────────────

interface RectSink {
  rect(x: number, y: number, w: number, h: number, color: string, alpha?: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

/** Wraps a PixelBuilder, adding a constant pixel offset to every rect. */
class OffsetBuilder implements RectSink {
  constructor(
    private readonly b: PixelBuilder,
    private readonly ox: number,
    private readonly oy: number,
  ) {}

  rect(x: number, y: number, w: number, h: number, color: string, alpha?: number): void {
    this.b.rect(Math.round(x + this.ox), Math.round(y + this.oy), Math.round(w), Math.round(h), color, alpha);
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.b.rect(Math.round(x + this.ox), Math.round(y + this.oy), Math.round(w), Math.round(h), '#000000', 0);
  }
}

/** Paint a filled pixel rect, separating color and alpha from rgba strings. */
function px(b: RectSink, x: number, y: number, width: number, height: number, color: string): void {
  const { color: hex, alpha } = parseColorAlpha(color);
  b.rect(Math.round(x), Math.round(y), Math.round(width), Math.round(height), hex, alpha);
}

// ─── Shared helpers ────────────────────────────────────────────────────

export type Mood = 'open' | 'sleep' | 'sad' | 'happy';

export function moodForPhase(phase: Phase): Mood {
  if (phase === 'sleeping') return 'sleep';
  if (phase === 'dejected') return 'sad';
  if (phase === 'celebrating') return 'happy';
  return 'open';
}


export function drawPixelEyes(
  b: RectSink,
  x1: number,
  x2: number,
  y: number,
  color: string,
  mood: Mood,
): void {
  if (mood === 'sleep') {
    px(b, x1, y, 3, 1, color);
    px(b, x2, y, 3, 1, color);
  } else if (mood === 'sad') {
    px(b, x1, y, 2, 1, color);
    px(b, x1 + 2, y + 1, 1, 1, color);
    px(b, x2 + 1, y + 1, 1, 1, color);
    px(b, x2 + 2, y, 2, 1, color);
  } else if (mood === 'happy') {
    px(b, x1, y, 2, 1, color);
    px(b, x1 + 2, y + 1, 1, 1, color);
    px(b, x2, y + 1, 1, 1, color);
    px(b, x2 + 1, y, 2, 1, color);
  } else {
    px(b, x1, y, 2, 2, color);
    px(b, x2, y, 2, 2, color);
  }
}

export function drawZzz(b: RectSink, x: number, y: number, color: string): void {
  px(b, x, y, 3, 1, color);
  px(b, x + 2, y + 1, 1, 1, color);
  px(b, x, y + 2, 3, 1, color);
}

export function drawVoxelMinerHead(
  b: RectSink,
  x: number,
  y: number,
  unit: number,
  mood: Mood,
): void {
  const c = voxelMinerPalette();
  // Hard hat / headlamp worker silhouette (not Steve face/hair grid)
  const rows = [
    'DDDDDDDD',
    'DHHHHHHD',
    'DHHHHHHD',
    'DSLLLSSD',
    mood === 'sleep' ? 'DSLLSLSD' : 'DSEESESD',
    'DSSssSSD',
    mood === 'sad' ? 'DSSMMMMD' : 'DSSMMSSD',
    'DDSSSSDD',
  ];
  const colors: Record<string, string> = {
    D: c.hairDark,
    H: c.hair,
    S: c.skin,
    s: c.skinDark,
    E: c.eye,
    L: c.mouth,
    M: c.mouth,
  };

  for (let row = 0; row < rows.length; row++) {
    for (let col = 0; col < rows[row].length; col++) {
      const color = colors[rows[row][col]];
      if (!color) continue;
      px(b, x + col * unit, y + row * unit, unit, unit, color);
    }
  }
}

// ─── Top-level dispatcher ──────────────────────────────────────────────

export function drawPixelMascot(
  b: PixelBuilder,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  activityOffset: number,
  workArmShift: number,
): void {
  const ctx = new OffsetBuilder(b, 8, 7 + activityOffset);

  switch (appearance.skin.id) {
    case 'classic-codebuddy':
      drawCodeBuddyMascot(ctx, appearance, phase, frame, workArmShift);
      break;
    case 'classic-codex':
      drawCodexMascot(ctx, appearance, phase, frame, workArmShift);
      break;
    case 'classic-claude':
      drawClaudeMascot(ctx, appearance, phase, frame, workArmShift);
      break;
    case 'classic-voxel-miner':
      drawVoxelMinerMascot(ctx, phase, frame, workArmShift);
      break;
    default:
      drawGeneratedSkin(ctx, appearance, phase, frame, workArmShift);
      break;
  }
}

// ─── Classic skins ─────────────────────────────────────────────────────

export function drawCodeBuddyMascot(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const mood = moodForPhase(phase);
  const bodyBob = 0;
  const y = mood === 'sad' ? 2 : bodyBob;
  const blink = workArmShift > 0;
  const armLift = phase === 'celebrating' ? -5 : 0;

  px(b, 5, 22, 14, 1, c.shadow);
  px(b, 11, y + 0, 2, 2, c.toolDark);
  px(b, 12, y - 1, 1, 1, c.accent);

  px(b, 5, y + 3, 14, 10, c.outline);
  px(b, 6, y + 4, 12, 8, c.primary);
  px(b, 7, y + 5, 10, 6, c.panel);
  px(b, 8, y + 6, 8, 1, c.panelLight);
  drawPixelEyes(b, 8, 14, y + 7, c.accent, blink ? 'sleep' : mood);
  px(b, 10, y + 10, mood === 'sad' ? 4 : 3, 1, c.accentDark);

  px(b, 7, y + 13, 10, 7, c.outline);
  px(b, 8, y + 14, 8, 5, c.primaryDark);
  px(b, 10, y + 15, 4, 2, c.accent);
  px(b, 11, y + 17, 2, 1, c.tool);
  px(b, 6, y + 15 + armLift + workArmShift, 2, phase === 'celebrating' ? 5 : 4, c.tool);
  px(b, 16, y + 15 + armLift + workArmShift, 2, phase === 'celebrating' ? 5 : 4, c.tool);
  px(b, 5, y + 19 + armLift + workArmShift, 3, 2, c.accentDark);
  px(b, 16, y + 19 + armLift + workArmShift, 3, 2, c.accentDark);
  px(b, 8, 20, 4, 2, c.toolDark);
  px(b, 13, 20, 4, 2, c.toolDark);
  px(b, 7, 22, 4, 1, c.outline);
  px(b, 14, 22, 4, 1, c.outline);

  if (phase === 'sleeping') {
    drawZzz(b, 17, 2 + (frame % 2), c.accent);
  }
}

export function drawCodexMascot(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const mood = moodForPhase(phase);
  const bodyBob = 0;
  const y = mood === 'sad' ? 2 : bodyBob;
  const cursorOn = phase === 'working' ? workArmShift > 0 : frame % 2 === 0;

  px(b, 4, 22, 16, 1, c.shadow);
  px(b, 4, y + 3, 16, 13, c.primary);
  px(b, 5, y + 4, 14, 11, c.outline);
  px(b, 6, y + 5, 12, 9, c.accent);
  px(b, 6, y + 5, 12, 2, c.primary);
  px(b, 8, y + 8, 2, 1, c.tool);
  px(b, 9, y + 9, 1, 1, c.tool);
  px(b, 8, y + 10, 2, 1, c.tool);
  drawPixelEyes(b, 11, 15, y + 8, c.primary, mood);
  px(b, 11, y + 12, mood === 'sad' ? 5 : 4, 1, c.primary);
  if (cursorOn && mood === 'open') px(b, 16, y + 12, 1, 1, c.tool);

  px(b, 10, y + 16, 4, 2, c.primary);
  px(b, 6, y + 18, 12, 3, c.primaryDark);
  px(b, 7, y + 19, 10, 1, c.panelLight);
  px(b, 4, y + 17 + workArmShift, 3, 5, c.toolDark);
  px(b, 17, y + 17 + workArmShift, 3, 5, c.toolDark);
  if (phase === 'celebrating') {
    px(b, 2, y + 10, 4, 2, c.tool);
    px(b, 18, y + 10, 4, 2, c.tool);
    px(b, 3, y + 8, 2, 2, c.accent);
    px(b, 19, y + 8, 2, 2, c.accent);
  }
  if (phase === 'sleeping') {
    drawZzz(b, 17, 2 + (frame % 2), c.tool);
  }
}

export function drawClaudeMascot(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const mood = moodForPhase(phase);
  const bodyBob = 0;
  const y = (mood === 'sad' ? 2 : 0) + bodyBob;
  const celebrate = phase === 'celebrating';

  px(b, 4, 22, 16, 1, c.shadow);
  px(b, 5, y + 8, 14, 5, c.outline);
  px(b, 6, y + 9, 12, 3, c.primary);
  px(b, 7, y + 7, 10, 2, c.primaryLight);
  px(b, 8, y + 5, 8, 3, c.primary);
  px(b, 9, y + 4, 6, 2, c.primaryDark);

  px(b, 7, y + 11, 10, 7, c.cream);
  drawPixelEyes(b, 9, 14, y + 13, c.outline, mood);
  px(b, 10, y + 16, mood === 'sad' ? 5 : 4, 1, c.outline);

  px(b, 6, y + 18, 12, 4, c.outline);
  px(b, 7, y + 18, 10, 3, c.primaryDark);
  px(b, 8, y + 19, 8, 1, c.primaryLight);

  px(b, 4, y + (celebrate ? 10 : 16) + workArmShift, 3, 6, c.primary);
  px(b, 17, y + (celebrate ? 10 : 16) + workArmShift, 3, 6, c.primary);
  px(b, 3, y + (celebrate ? 8 : 20) + workArmShift, 3, 2, c.accent);
  px(b, 18, y + (celebrate ? 8 : 20) + workArmShift, 3, 2, c.accent);
  px(b, 7, 22, 4, 1, c.toolDark);
  px(b, 13, 22, 4, 1, c.toolDark);

  if (phase === 'sleeping') {
    drawZzz(b, 17, 2 + (frame % 2), c.primaryLight);
  }
}

export function drawVoxelMinerMascot(
  b: RectSink,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = voxelMinerPalette();
  const mood = moodForPhase(phase);
  const y = mood === 'sad' ? 2 : 0;
  const celebrate = phase === 'celebrating';

  px(b, 4, 22, 16, 1, 'rgba(46,32,24,0.26)');
  drawVoxelMinerHead(b, 8, y + 1, 1, mood);

  px(b, 8, y + 8, 8, 8, c.outline);
  px(b, 9, y + 9, 6, 7, c.shirt);
  px(b, 10, y + 9, 4, 2, c.shirtLight);
  px(b, 5, y + 8 + (celebrate ? -3 : workArmShift), 3, 10, c.skin);
  px(b, 16, y + 8 + (celebrate ? -3 : workArmShift), 3, 10, c.skin);
  px(b, 5, y + 8 + (celebrate ? -3 : workArmShift), 3, 3, c.shirtDark);
  px(b, 16, y + 8 + (celebrate ? -3 : workArmShift), 3, 3, c.shirtDark);

  px(b, 8, 16, 4, 6, c.pants);
  px(b, 12, 16, 4, 6, c.pantsDark);
  px(b, 7, 22, 5, 1, c.shoe);
  px(b, 12, 22, 5, 1, c.shoe);

  if (phase === 'sleeping') {
    drawZzz(b, 18, 1 + (frame % 2), c.diamondLight);
  }
}

// ─── Generated skins ───────────────────────────────────────────────────

export function drawGeneratedSkin(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  switch (appearance.skin.id) {
    case 'red-jumper':
      drawRedJumper(b, c, phase, frame, workArmShift);
      break;
    case 'green-quest':
      drawGreenQuest(b, c, phase, frame, workArmShift);
      break;
    case 'blue-dash':
      drawBlueDash(b, c, phase, frame, workArmShift);
      break;
    case 'block-miner':
      drawBlockMiner(b, c, phase, frame, workArmShift);
      break;
    case 'space-bounty':
      drawSpaceBounty(b, c, phase, frame, workArmShift);
      break;
    case 'arcade-ghost':
      drawArcadeGhost(b, c, phase, frame);
      break;
    case 'rune-mage':
      drawRuneMage(b, c, phase, frame, workArmShift);
      break;
    case 'shadow-ninja':
      drawShadowNinja(b, c, phase, frame, workArmShift);
      break;
    case 'slime-king':
      drawSlimeKing(b, c, phase, frame);
      break;
  }
}

type GeneratedPalette = ReturnType<typeof skinPalette>;

export function drawHumanoidBase(
  b: RectSink,
  c: GeneratedPalette,
  phase: Phase,
  headY: number,
  workArmShift = 0,
): { y: number; mood: Mood; workArmShift: number } {
  const mood = moodForPhase(phase);
  const bodyBob = 0;
  const y = headY + (mood === 'sad' ? 2 : bodyBob);
  const celebrate = phase === 'celebrating';

  px(b, 5, 22, 14, 1, c.shadow);
  px(b, 8, y + 3, 8, 7, c.outline);
  px(b, 9, y + 4, 6, 5, c.cream);
  drawPixelEyes(b, 9, 13, y + 6, c.outline, mood);
  px(b, 10, y + 9, mood === 'sad' ? 5 : 4, 1, c.outline);
  px(b, 7, y + 11, 10, 8, c.outline);
  px(b, 8, y + 12, 8, 6, c.primary);
  px(b, 9, y + 13, 6, 2, c.primaryLight);
  px(b, 5, y + (celebrate ? 8 : 13) + workArmShift, 3, 6, c.primaryDark);
  px(b, 16, y + (celebrate ? 8 : 13) + workArmShift, 3, 6, c.primaryDark);
  px(b, 6, y + (celebrate ? 7 : 18) + workArmShift, 3, 2, c.tool);
  px(b, 15, y + (celebrate ? 7 : 18) + workArmShift, 3, 2, c.tool);
  px(b, 8, 20, 4, 2, c.toolDark);
  px(b, 13, 20, 4, 2, c.toolDark);
  return { y, mood, workArmShift };
}

export function drawRedJumper(b: RectSink, c: GeneratedPalette, phase: Phase, frame: number, workArmShift: number): void {
  void frame;
  const { y } = drawHumanoidBase(b, c, phase, 2, workArmShift);
  px(b, 7, y + 1, 10, 3, c.primary);
  px(b, 8, y, 8, 2, c.primaryLight);
  px(b, 15, y + 2, 3, 1, c.accent);
  px(b, 9, y + 15 + workArmShift, 2, 3, c.accent);
  px(b, 13, y + 15 + workArmShift, 2, 3, c.accent);
}

export function drawGreenQuest(b: RectSink, c: GeneratedPalette, phase: Phase, frame: number, workArmShift: number): void {
  void frame;
  const { y } = drawHumanoidBase(b, c, phase, 2, workArmShift);
  px(b, 11, y - 1, 3, 1, c.accent);
  px(b, 9, y, 7, 2, c.primary);
  px(b, 8, y + 2, 9, 2, c.primaryDark);
  px(b, 10, y + 12, 4, 6, c.primaryDark);
  px(b, 18, y + 8 + workArmShift, 1, 11, c.tool);
  px(b, 17, y + 7 + workArmShift, 3, 2, c.accent);
}

export function drawBlueDash(b: RectSink, c: GeneratedPalette, phase: Phase, frame: number, workArmShift: number): void {
  void frame;
  const { y } = drawHumanoidBase(b, c, phase, 2, workArmShift);
  px(b, 7, y + 2, 10, 3, c.primaryDark);
  px(b, 8, y, 2, 2, c.accent);
  px(b, 11, y - 1, 2, 3, c.accent);
  px(b, 14, y, 2, 2, c.accent);
  px(b, 8, y + 6, 8, 2, c.accent);
  px(b, 4, 18, 3, 1, c.accent);
  px(b, 17, 20, 4, 1, c.accent);
}

export function drawBlockMiner(b: RectSink, c: GeneratedPalette, phase: Phase, frame: number, workArmShift: number): void {
  void frame;
  const { y } = drawHumanoidBase(b, c, phase, 3, workArmShift);
  px(b, 7, y, 10, 4, c.tool);
  px(b, 8, y + 1, 8, 2, c.accent);
  px(b, 11, y, 2, 1, c.white);
  px(b, 18, y + 7 + workArmShift, 2, 9, c.tool);
  px(b, 16, y + 6 + workArmShift, 6, 2, c.tool);
  px(b, 20, y + 5 + workArmShift, 2, 2, c.accent);
}

export function drawSpaceBounty(b: RectSink, c: GeneratedPalette, phase: Phase, frame: number, workArmShift: number): void {
  const mood = moodForPhase(phase);
  const bodyBob = 0;
  const y = 2 + (mood === 'sad' ? 2 : bodyBob);
  px(b, 5, 22, 14, 1, c.shadow);
  px(b, 6, y + 2, 12, 10, c.outline);
  px(b, 7, y + 3, 10, 8, c.primary);
  px(b, 8, y + 5, 8, 4, c.panel);
  drawPixelEyes(b, 9, 13, y + 6, c.accent, mood);
  px(b, 7, y + 13, 10, 7, c.outline);
  px(b, 8, y + 14, 8, 5, c.primaryDark);
  px(b, 4, y + 15 + workArmShift, 3, 5, c.tool);
  px(b, 17, y + 15 + workArmShift, 3, 5, c.tool);
  px(b, 5, y + 20 + workArmShift, 2, 2, c.accent);
  px(b, 17, y + 20 + workArmShift, 2, 2, c.accent);
}

export function drawArcadeGhost(b: RectSink, c: GeneratedPalette, phase: Phase, frame: number): void {
  void frame;
  const mood = moodForPhase(phase);
  const bodyDrift = 0;
  const accentWave = 0;
  const y = 5 + bodyDrift + (mood === 'sad' ? 2 : 0);
  px(b, 5, 22, 14, 1, c.shadow);
  px(b, 6, y + 1, 12, 11, c.outline);
  px(b, 7, y, 10, 12, c.primary);
  px(b, 8, y + 2, 8, 2, c.primaryLight);
  drawPixelEyes(b, 9, 14, y + 5, c.panel, mood);
  px(b, 11, y + 8, 3, 2, c.panel);
  px(b, 7, y + 12, 2, 2, c.primary);
  px(b, 11, y + 12, 2, 2, c.primary);
  px(b, 15, y + 12, 2, 2, c.primary);
  px(b, 17, y + 8 + accentWave, 2, 2, c.accent);
}

export function drawRuneMage(b: RectSink, c: GeneratedPalette, phase: Phase, frame: number, workArmShift: number): void {
  void frame;
  const { y } = drawHumanoidBase(b, c, phase, 3, workArmShift);
  px(b, 10, y - 2, 4, 2, c.accent);
  px(b, 8, y, 8, 4, c.primaryDark);
  px(b, 9, y + 4, 6, 3, c.primary);
  px(b, 11, y + 13, 2, 3, c.accent);
  px(b, 18, y + 6 + workArmShift, 1, 12, c.tool);
  px(b, 17, y + 5 + workArmShift, 3, 3, c.accent);
  px(b, 18, y + 6 + workArmShift, 1, 1, c.white);
}

export function drawShadowNinja(b: RectSink, c: GeneratedPalette, phase: Phase, frame: number, workArmShift: number): void {
  void frame;
  const { y } = drawHumanoidBase(b, c, phase, 3, workArmShift);
  px(b, 7, y + 2, 10, 7, c.panel);
  px(b, 8, y + 5, 8, 2, c.accent);
  px(b, 16, y + 3, 4, 2, c.accent);
  px(b, 4, y + 16 + workArmShift, 16, 1, c.tool);
  px(b, 17, y + 15 + workArmShift, 2, 3, c.white);
}

export function drawSlimeKing(b: RectSink, c: GeneratedPalette, phase: Phase, frame: number): void {
  void frame;
  const mood = moodForPhase(phase);
  const bodyBounce = 0;
  const crownWave = 0;
  const y = 7 + (mood === 'sad' ? 2 : -bodyBounce);
  px(b, 5, 22, 14, 1, c.shadow);
  px(b, 7, y + 1, 10, 1, c.accent);
  px(b, 8, y - 1 + crownWave, 2, 3, c.accent);
  px(b, 11, y - 2 + crownWave, 2, 4, c.accent);
  px(b, 14, y - 1 + crownWave, 2, 3, c.accent);
  px(b, 5, y + 4, 14, 11, c.outline);
  px(b, 6, y + 3, 12, 12, c.primary);
  px(b, 8, y + 5, 8, 2, c.primaryLight);
  drawPixelEyes(b, 9, 14, y + 8, c.panel, mood);
  px(b, 11, y + 12, mood === 'sad' ? 4 : 3, 1, c.panel);
  px(b, 6, y + 14, 3, 2, c.primaryDark);
  px(b, 15, y + 14, 3, 2, c.primaryDark);
}
