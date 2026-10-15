/**
 * Live-only worker skin pixel drawing.
 *
 * All 13 production skins share one crew body (planted legs and boots, a
 * uniform torso, arms and a head) in the Lamplight workshop palette. Each
 * role adds its own headgear, uniform detail and hand tool; the three
 * official client mascots swap the head for their own and keep the crew
 * uniform. Drawing targets a PixelBuilder (src/render): `px` maps to filled
 * pixel rects and OffsetBuilder applies the sprite's local offset.
 *
 * Local sprite space: the figure stands on row 21 with its ground shadow on
 * row 22, centred between columns 11 and 12.
 */

import type { Appearance, Phase } from '../../../shared/snapshot';
import type { PixelBuilder } from '../../../render';
import { CREW_COLORS, parseColorAlpha, skinPalette, voxelMinerPalette, type SkinPalette } from './palette';

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

/** A 4x4 pixel "Z". */
export function drawZzz(b: RectSink, x: number, y: number, color: string): void {
  px(b, x, y, 4, 1, color);
  px(b, x + 2, y + 1, 1, 1, color);
  px(b, x + 1, y + 2, 1, 1, color);
  px(b, x, y + 3, 4, 1, color);
}

/** Pose facts the role layers draw against. */
interface Pose {
  phase: Phase;
  mood: Mood;
  /** Upper-body drop: 1 while dozing, 2 when dejected. */
  y: number;
  /** Tool shaft column and the top row of the right-hand grip. */
  hx: number;
  hy: number;
}

type HeadPainter = (b: RectSink, y: number, mood: Mood) => void;

/** Eyes, cheeks and mouth centred on the head; eyes start on row `ey`. */
function drawFace(b: RectSink, ey: number, mood: Mood, eye: string, mouth: string, blush?: string): void {
  if (mood === 'sleep') {
    px(b, 9, ey + 1, 2, 1, eye);
    px(b, 13, ey + 1, 2, 1, eye);
    px(b, 11, ey + 3, 2, 1, mouth);
  } else if (mood === 'happy') {
    px(b, 9, ey + 1, 1, 1, eye);
    px(b, 10, ey, 1, 1, eye);
    px(b, 13, ey, 1, 1, eye);
    px(b, 14, ey + 1, 1, 1, eye);
    px(b, 11, ey + 2, 2, 2, mouth);
  } else if (mood === 'sad') {
    px(b, 10, ey + 1, 1, 1, eye);
    px(b, 13, ey + 1, 1, 1, eye);
    px(b, 11, ey + 3, 2, 1, mouth);
    px(b, 10, ey + 4, 1, 1, mouth);
    px(b, 13, ey + 4, 1, 1, mouth);
    px(b, 14, ey + 2, 1, 1, CREW_COLORS.metalLight);
  } else {
    px(b, 10, ey, 1, 2, eye);
    px(b, 13, ey, 1, 2, eye);
    px(b, 11, ey + 3, 2, 1, mouth);
  }
  if (blush && mood !== 'sad') {
    px(b, 9, ey + 2, 1, 1, blush);
    px(b, 14, ey + 2, 1, 1, blush);
  }
}

function humanHead(c: SkinPalette): HeadPainter {
  return (b, y, mood) => {
    px(b, 8, y + 3, 8, 9, c.outline);
    px(b, 7, y + 4, 10, 7, c.outline);
    px(b, 8, y + 4, 8, 7, c.skin);
    px(b, 8, y + 10, 8, 1, c.skinShade);
    drawFace(b, y + 6, mood, c.outline, c.mouth, c.blush);
  };
}

/** Shared crew body. Returns where the role's tool is gripped. */
function drawCrewBody(
  b: RectSink,
  c: SkinPalette,
  phase: Phase,
  workArmShift: number,
  head: HeadPainter,
  hand: string = c.skin,
): Pose {
  const mood = moodForPhase(phase);
  const y = mood === 'sad' ? 2 : mood === 'sleep' ? 1 : 0;
  const s = workArmShift;

  px(b, 6, 22, 12, 1, c.shadow);
  // Legs and boots stay planted while the upper body slumps.
  px(b, 8, 17, 8, 4, c.outline);
  px(b, 9, 17, 2, 3, c.pants);
  px(b, 13, 17, 2, 3, c.pants);
  px(b, 7, 20, 4, 2, c.outline);
  px(b, 13, 20, 4, 2, c.outline);
  px(b, 8, 20, 2, 1, c.boot);
  px(b, 14, 20, 2, 1, c.boot);

  // Uniform torso.
  px(b, 8, y + 11, 8, 7, c.outline);
  px(b, 9, y + 12, 6, 5, c.primary);
  px(b, 9, y + 12, 6, 1, c.primaryLight);
  px(b, 9, y + 16, 6, 1, c.primaryDark);

  head(b, y, mood);

  if (phase === 'celebrating') {
    px(b, 5, y + 6, 3, 7, c.outline);
    px(b, 6, y + 7, 1, 2, hand);
    px(b, 6, y + 9, 1, 3, c.primary);
    px(b, 16, y + 6 + s, 3, 7 - s, c.outline);
    px(b, 17, y + 7 + s, 1, 2, hand);
    px(b, 17, y + 9 + s, 1, 3 - s, c.primary);
    px(b, 18, y + 7 + s, 1, 2, hand);
    return { phase, mood, y, hx: 19, hy: y + 7 + s };
  }
  px(b, 6, y + 12, 3, 6, c.outline);
  px(b, 7, y + 12, 1, 3, c.primary);
  px(b, 7, y + 15, 1, 2, hand);
  px(b, 15, y + 12 + s, 3, 6, c.outline);
  px(b, 16, y + 12 + s, 1, 3, c.primary);
  px(b, 16, y + 15 + s, 2, 2, hand);
  return { phase, mood, y, hx: 18, hy: y + 15 + s };
}

function hardHat(b: RectSink, c: SkinPalette, y: number, fill: string, shade: string, shine: string): void {
  px(b, 8, y, 8, 1, c.outline);
  px(b, 7, y + 1, 10, 4, c.outline);
  px(b, 6, y + 4, 12, 2, c.outline);
  px(b, 8, y + 1, 8, 3, fill);
  px(b, 7, y + 4, 10, 1, fill);
  px(b, 11, y + 1, 2, 3, shade);
  px(b, 9, y + 1, 1, 2, shine);
}

function twinkle(b: RectSink, x: number, y: number, color: string): void {
  px(b, x, y - 1, 1, 3, color);
  px(b, x - 1, y, 3, 1, color);
}

/** Sleep Zs and celebration twinkles shared by every skin. */
function drawPhaseFx(b: RectSink, c: SkinPalette, p: Pose, frame: number): void {
  const f = frame % 2;
  if (p.phase === 'sleeping') {
    drawZzz(b, 20, -1 + f, c.outline);
    drawZzz(b, 19, -2 + f, c.lamp);
    drawZzz(b, 24, -6 + f, c.outline);
    drawZzz(b, 23, -7 + f, c.lamp);
  } else if (p.phase === 'celebrating') {
    twinkle(b, f ? 2 : 1, f ? 2 : 4, c.lamp);
    twinkle(b, f ? 21 : 22, f ? 14 : 12, c.lampDeep);
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

// ─── Official client mascots in crew uniform ───────────────────────────

export function drawCodeBuddyMascot(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const p = drawCrewBody(b, c, phase, workArmShift, (s, y, mood) => {
    // Robot head with an antenna bulb, ear lights and a face screen.
    px(s, 10, y - 2, 4, 4, c.outline);
    px(s, 11, y - 1, 2, 2, c.accent);
    px(s, 7, y + 2, 10, 10, c.outline);
    px(s, 6, y + 5, 12, 4, c.outline);
    px(s, 8, y + 3, 8, 8, c.primary);
    px(s, 8, y + 3, 8, 1, c.primaryLight);
    px(s, 9, y + 4, 6, 6, c.tool);
    px(s, 6, y + 6, 1, 2, c.accentDark);
    px(s, 17, y + 6, 1, 2, c.accentDark);
    drawFace(s, y + 5, mood, c.accent, c.accent);
  }, c.primaryLight);
  px(b, 11, p.y + 13, 2, 2, c.accent);
  drawPhaseFx(b, c, p, frame);
}

export function drawCodexMascot(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const cursorOn = phase === 'working' ? workArmShift > 0 : frame % 2 === 0;
  const p = drawCrewBody(b, c, phase, workArmShift, (s, y, mood) => {
    // Terminal head: cream bezel around a dark prompt screen.
    px(s, 7, y + 2, 10, 10, c.outline);
    px(s, 8, y + 3, 8, 8, c.cream);
    px(s, 9, y + 4, 6, 6, c.primary);
    px(s, 8, y + 10, 8, 1, c.paperShade);
    drawFace(s, y + 5, mood, c.accent, c.accent);
    if (cursorOn && mood === 'open') px(s, 14, y + 8, 1, 1, c.accent);
  }, c.cream);
  px(b, 10, p.y + 12, 1, 2, c.cream);
  px(b, 13, p.y + 12, 1, 2, c.cream);
  drawPhaseFx(b, c, p, frame);
}

export function drawClaudeMascot(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const p = drawCrewBody(b, c, phase, workArmShift, (s, y, mood) => {
    // Wide orange block head with side nubs.
    px(s, 4, y + 6, 16, 4, c.outline);
    px(s, 6, y + 3, 12, 9, c.outline);
    px(s, 7, y + 4, 10, 7, c.primary);
    px(s, 7, y + 4, 10, 1, c.primaryLight);
    px(s, 5, y + 7, 2, 2, c.primary);
    px(s, 17, y + 7, 2, 2, c.primary);
    drawFace(s, y + 6, mood, c.outline, c.tool, c.accent);
  }, c.accent);
  px(b, 10, p.y + 12, 4, 1, c.accent);
  drawPhaseFx(b, c, p, frame);
}

// ─── Classic headlamp miner ────────────────────────────────────────────

export function drawVoxelMinerMascot(
  b: RectSink,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const v = voxelMinerPalette();
  const c: SkinPalette = {
    ...CREW_COLORS,
    primary: v.shirt,
    primaryDark: v.shirtDark,
    primaryLight: v.shirtLight,
    accent: v.diamond,
    accentDark: v.diamondDark,
    tool: v.handle,
    toolDark: v.handleDark,
    skin: v.skin,
    skinShade: v.skinDark,
    pants: v.pants,
  };
  const p = drawCrewBody(b, c, phase, workArmShift, humanHead(c));
  const { y, hx: x, hy } = p;
  hardHat(b, c, y, v.hairLight, v.hair, c.metalLight);
  px(b, 11, y + 1, 2, 2, v.diamond);
  px(b, 11, y + 1, 1, 1, v.diamondLight);
  px(b, 9, y + 15, 6, 1, v.handleDark);
  px(b, 11, y + 15, 2, 1, v.diamond);
  // Wooden-handled pick.
  px(b, x, hy - 4, 1, 7, c.tool);
  px(b, x - 1, hy - 7, 5, 3, c.outline);
  px(b, x - 2, hy - 6, 1, 2, c.outline);
  px(b, x + 4, hy - 6, 1, 2, c.outline);
  px(b, x, hy - 6, 3, 1, c.metalLight);
  drawPhaseFx(b, c, p, frame);
}

// ─── Original crew roles ───────────────────────────────────────────────

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
      drawArcadeGhost(b, c, phase, frame, workArmShift);
      break;
    case 'rune-mage':
      drawRuneMage(b, c, phase, frame, workArmShift);
      break;
    case 'shadow-ninja':
      drawShadowNinja(b, c, phase, frame, workArmShift);
      break;
    case 'slime-king':
      drawSlimeKing(b, c, phase, frame, workArmShift);
      break;
  }
}

/** Carpenter: lamp hard hat, bib overalls with tool belt, claw hammer. */
export function drawRedJumper(b: RectSink, c: SkinPalette, phase: Phase, frame: number, workArmShift: number): void {
  const p = drawCrewBody(b, c, phase, workArmShift, humanHead(c));
  const { y, hx: x, hy } = p;
  hardHat(b, c, y, c.lamp, c.lampDeep, c.lampLight);
  px(b, 11, y + 13, 2, 2, c.primaryDark);
  px(b, 9, y + 15, 6, 1, c.woodDark);
  px(b, 11, y + 15, 2, 1, c.lamp);
  px(b, x, hy - 3, 1, 6, c.woodDark);
  px(b, x - 1, hy - 6, 5, 3, c.outline);
  px(b, x, hy - 5, 3, 1, c.metalLight);
  drawPhaseFx(b, c, p, frame);
}

/** Gardener: straw sun hat with a moss band, apron, shovel. */
export function drawGreenQuest(b: RectSink, c: SkinPalette, phase: Phase, frame: number, workArmShift: number): void {
  const p = drawCrewBody(b, c, phase, workArmShift, humanHead(c));
  const { y, hx: x, hy } = p;
  px(b, 8, y + 1, 8, 1, c.outline);
  px(b, 7, y + 2, 10, 2, c.outline);
  px(b, 5, y + 4, 14, 2, c.outline);
  px(b, 8, y + 2, 8, 1, c.lampDeep);
  px(b, 8, y + 3, 8, 1, c.moss);
  px(b, 6, y + 4, 12, 1, c.lampDeep);
  px(b, 9, y + 2, 2, 1, c.lamp);
  px(b, 10, y + 13, 4, 3, c.moss);
  px(b, x - 1, hy - 6, 3, 1, c.woodDark);
  px(b, x, hy - 5, 1, 9, c.woodDark);
  px(b, x - 1, hy + 3, 3, 3, c.outline);
  px(b, x, hy + 3, 1, 2, c.metalLight);
  drawPhaseFx(b, c, p, frame);
}

/** Runner: striped cap, race bib, sealed envelope, speed lines. */
export function drawBlueDash(b: RectSink, c: SkinPalette, phase: Phase, frame: number, workArmShift: number): void {
  const p = drawCrewBody(b, c, phase, workArmShift, humanHead(c));
  const { y, hx: x, hy } = p;
  px(b, 8, y + 1, 8, 1, c.outline);
  px(b, 7, y + 2, 10, 4, c.outline);
  px(b, 15, y + 4, 4, 2, c.outline);
  px(b, 8, y + 2, 8, 2, c.primaryDark);
  px(b, 8, y + 4, 8, 1, c.lamp);
  px(b, 16, y + 4, 2, 1, c.primaryDark);
  px(b, 10, y + 13, 4, 3, c.paper);
  px(b, 11, y + 14, 2, 1, c.terracotta);
  px(b, x, hy - 1, 5, 4, c.outline);
  px(b, x + 1, hy, 3, 2, c.paper);
  px(b, x + 2, hy, 1, 1, c.terracotta);
  if (phase === 'working') {
    const f = frame % 2;
    px(b, 1 + f, y + 13, 3, 1, c.lampDeep);
    px(b, 2 - f, y + 16, 3, 1, c.lampDeep);
  }
  drawPhaseFx(b, c, p, frame);
}

/** Mason: paper hard hat, reflective stripe, trowel, brick at the feet. */
export function drawBlockMiner(b: RectSink, c: SkinPalette, phase: Phase, frame: number, workArmShift: number): void {
  const p = drawCrewBody(b, c, phase, workArmShift, humanHead(c));
  const { y, hx: x, hy } = p;
  hardHat(b, c, y, c.paper, c.paperShade, c.white);
  px(b, 9, y + 14, 6, 1, c.paper);
  px(b, x, hy - 1, 1, 3, c.woodDark);
  px(b, x - 1, hy - 5, 3, 4, c.outline);
  px(b, x, hy - 5, 1, 3, c.metalLight);
  px(b, 18, 19, 6, 3, c.outline);
  px(b, 19, 20, 4, 1, c.terracotta);
  drawPhaseFx(b, c, p, frame);
}

/** Welder: flip-up mask, leather apron, torch with sparks. */
export function drawSpaceBounty(b: RectSink, c: SkinPalette, phase: Phase, frame: number, workArmShift: number): void {
  const p = drawCrewBody(b, c, phase, workArmShift, humanHead(c));
  const { y, hx: x, hy } = p;
  px(b, 7, y, 10, 5, c.outline);
  px(b, 8, y + 1, 8, 3, c.metal);
  px(b, 9, y + 2, 6, 1, c.outline);
  px(b, 10, y + 2, 2, 1, c.lamp);
  px(b, 7, y + 5, 10, 1, c.outline);
  px(b, 10, y + 13, 4, 4, c.woodDark);
  px(b, x, hy - 1, 1, 4, c.metal);
  px(b, x, hy - 3, 3, 2, c.outline);
  px(b, x + 1, hy - 3, 2, 1, c.metalLight);
  if (phase === 'working') {
    const f = frame % 2;
    px(b, x + 3, hy - 3, 1, 1, c.lampLight);
    px(b, x + 4, hy - 4 - f, 1, 1, c.lamp);
    px(b, x + 4, hy - 2 + f, 1, 1, c.lampDeep);
  }
  drawPhaseFx(b, c, p, frame);
}

/** Night Watch: knit cap with a lamp pompom, coat badge, lantern. */
export function drawArcadeGhost(b: RectSink, c: SkinPalette, phase: Phase, frame: number, workArmShift = 0): void {
  const p = drawCrewBody(b, c, phase, workArmShift, humanHead(c));
  const { y, hx: x, hy } = p;
  px(b, 10, y - 2, 4, 3, c.outline);
  px(b, 11, y - 1, 2, 1, c.lamp);
  px(b, 8, y + 1, 8, 1, c.outline);
  px(b, 7, y + 2, 10, 4, c.outline);
  px(b, 8, y + 2, 8, 2, c.primaryDark);
  px(b, 8, y + 4, 8, 1, c.primaryLight);
  px(b, 13, y + 13, 1, 1, c.lamp);
  px(b, x + 1, hy - 1, 1, 1, c.outline);
  px(b, x, hy, 3, 5, c.outline);
  px(b, x + 1, hy + 1, 1, 3, frame % 2 === 0 ? c.lamp : c.lampLight);
  drawPhaseFx(b, c, p, frame);
}

/** Surveyor: tan bucket hat, lamp-striped vest, striped ranging pole. */
export function drawRuneMage(b: RectSink, c: SkinPalette, phase: Phase, frame: number, workArmShift: number): void {
  const p = drawCrewBody(b, c, phase, workArmShift, humanHead(c));
  const { y, hx: x, hy } = p;
  px(b, 8, y + 1, 8, 1, c.outline);
  px(b, 7, y + 2, 10, 4, c.outline);
  px(b, 6, y + 4, 12, 2, c.outline);
  px(b, 8, y + 2, 8, 2, c.wood);
  px(b, 7, y + 4, 10, 1, c.woodDark);
  px(b, 10, y + 12, 1, 4, c.lamp);
  px(b, 13, y + 12, 1, 4, c.lamp);
  const top = hy - 9;
  const bottom = phase === 'celebrating' ? hy + 4 : 21;
  px(b, x - 1, top - 1, 3, bottom - top + 2, c.outline);
  for (let r = top; r < bottom; r++) {
    px(b, x, r, 1, 1, Math.floor((r - top) / 2) % 2 === 0 ? c.terracotta : c.paper);
  }
  px(b, x - 1, hy, 1, 2, c.skin);
  drawPhaseFx(b, c, p, frame);
}

/** Roofer: dotted bandana, suspenders, stack of roof tiles. */
export function drawShadowNinja(b: RectSink, c: SkinPalette, phase: Phase, frame: number, workArmShift: number): void {
  const p = drawCrewBody(b, c, phase, workArmShift, humanHead(c));
  const { y, hx: x, hy } = p;
  px(b, 4, y + 3, 4, 3, c.outline);
  px(b, 5, y + 4, 2, 1, c.moss);
  px(b, 8, y + 2, 8, 1, c.outline);
  px(b, 7, y + 3, 10, 3, c.outline);
  px(b, 8, y + 3, 8, 2, c.moss);
  px(b, 10, y + 3, 1, 1, c.paper);
  px(b, 13, y + 4, 1, 1, c.paper);
  px(b, 10, y + 12, 1, 4, c.primaryDark);
  px(b, 13, y + 12, 1, 4, c.primaryDark);
  px(b, x, hy - 2, 5, 5, c.outline);
  px(b, x + 1, hy - 1, 3, 1, c.terracotta);
  px(b, x + 1, hy + 1, 3, 1, c.terracotta);
  drawPhaseFx(b, c, p, frame);
}

/** Foreman: terracotta hard hat, moustache, tie, clipboard. */
export function drawSlimeKing(b: RectSink, c: SkinPalette, phase: Phase, frame: number, workArmShift = 0): void {
  const p = drawCrewBody(b, c, phase, workArmShift, humanHead(c));
  const { y, hx: x, hy } = p;
  hardHat(b, c, y, c.terracotta, c.mouth, c.blush);
  px(b, 10, y + 8, 4, 1, c.boot);
  px(b, 11, y + 12, 2, 1, c.paper);
  px(b, 11, y + 13, 2, 3, c.terracotta);
  px(b, x, hy - 3, 4, 6, c.outline);
  px(b, x + 1, hy - 2, 2, 4, c.paper);
  px(b, x + 1, hy - 3, 2, 1, c.metalLight);
  px(b, x + 1, hy, 2, 1, c.paperShade);
  drawPhaseFx(b, c, p, frame);
}
