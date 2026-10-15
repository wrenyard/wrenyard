/**
 * Video-game character skins (classic).
 *
 * Ten original pixel-art skins that evoke classic video-game character themes
 * without copying any game's sprite or logo. Each drawer paints a finished
 * figure in the Lamplight palette supplied by `skinPalette(appearance)` and
 * shares the crew's coordinate contract: the figure stands on row 21 with its
 * ground shadow on row 22, centred between columns 11 and 12, with every drawn
 * pixel inside x 0..23 and y 0..22.
 *
 * Humanoid skins reuse the shared crew body (`drawCrewBody`), which supplies
 * the planted legs, arms, work-arm shift, celebrate pose and hand grip, and
 * give it a distinct head, outfit and prop. Blue Dash, Space Bounty, Arcade
 * Ghost and Slime King are deliberately non-human silhouettes.
 */

import type { Appearance, Phase } from '../../../shared/snapshot';
import { skinPalette } from './palette';
import {
  drawCrewBody,
  drawFace,
  drawPhaseFx,
  moodForPhase,
  px,
  type RectSink,
} from './skin-drawer';

/** Whole-body drop shared by the custom (non-crew) drawers. */
function slump(mood: ReturnType<typeof moodForPhase>): number {
  return mood === 'sad' ? 2 : mood === 'sleep' ? 1 : 0;
}

// ─── 1. Voxel Miner ────────────────────────────────────────────────────

/** Blocky voxel-game miner: square head, flat block-hair cap, cyan pickaxe. */
export function drawGameVoxelMiner(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const p = drawCrewBody(b, c, phase, workArmShift, (s, y, mood) => {
    // Flat block-hair cap on a perfectly square head.
    px(s, 8, y + 1, 8, 2, c.outline);
    px(s, 9, y + 1, 6, 1, c.woodDark);
    px(s, 8, y + 3, 8, 8, c.outline);
    px(s, 9, y + 4, 6, 6, c.skin);
    px(s, 9, y + 9, 6, 1, c.skinShade);
    drawFace(s, y + 5, mood, c.outline, c.mouth);
    // Blocky sideburns.
    px(s, 8, y + 8, 1, 2, c.woodDark);
    px(s, 15, y + 8, 1, 2, c.woodDark);
  });
  const { y, hx: x, hy } = p;
  // Belt.
  px(b, 8, y + 15, 8, 1, c.outline);
  px(b, 9, y + 15, 6, 1, c.woodDark);
  // Pickaxe with a cyan diamond head; swings with workArmShift through hy.
  px(b, x, hy - 4, 1, 7, c.woodDark);
  px(b, x - 3, hy - 6, 7, 2, c.outline);
  px(b, x - 2, hy - 6, 5, 1, c.accent);
  px(b, x - 3, hy - 5, 1, 1, c.accent);
  px(b, x + 3, hy - 5, 1, 1, c.accent);
  drawPhaseFx(b, c, p, frame);
}

// ─── 2. Red Jumper ─────────────────────────────────────────────────────

/** Platform-game plumber: red cap with a cream emblem, moustache, overalls. */
export function drawGameRedJumper(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const mood = moodForPhase(phase);
  const jump = phase === 'celebrating' ? 2 : 0;
  const uy = slump(mood) - jump; // upper-body shift
  const ly = -jump; // feet lift only when jumping

  px(b, 6, 22, 12, 1, c.shadow);

  // Legs: blue overalls and brown boots (planted unless jumping).
  px(b, 8, 17 + ly, 8, 4, c.outline);
  px(b, 9, 17 + ly, 2, 3, c.accent);
  px(b, 13, 17 + ly, 2, 3, c.accent);
  px(b, 7, 20 + ly, 4, 2, c.outline);
  px(b, 8, 20 + ly, 2, 1, c.boot);
  px(b, 13, 20 + ly, 4, 2, c.outline);
  px(b, 14, 20 + ly, 2, 1, c.boot);

  // Torso: red shirt under blue overalls with lamp buttons.
  px(b, 8, 12 + uy, 8, 6, c.outline);
  px(b, 9, 12 + uy, 6, 6, c.primary);
  px(b, 9, 12 + uy, 6, 1, c.primaryLight);
  px(b, 9, 15 + uy, 6, 3, c.accent);
  px(b, 10, 13 + uy, 1, 3, c.accent);
  px(b, 13, 13 + uy, 1, 3, c.accent);
  px(b, 10, 16 + uy, 1, 1, c.tool);
  px(b, 13, 16 + uy, 1, 1, c.tool);

  // Head with a big nose and dark moustache.
  px(b, 7, 6 + uy, 10, 1, c.outline);
  px(b, 7, 11 + uy, 10, 1, c.outline);
  px(b, 7, 6 + uy, 1, 6, c.outline);
  px(b, 16, 6 + uy, 1, 6, c.outline);
  px(b, 8, 7 + uy, 8, 4, c.skin);
  px(b, 11, 8 + uy, 2, 1, c.skinShade);
  px(b, 9, 9 + uy, 6, 1, c.boot);
  if (mood === 'sleep') {
    px(b, 10, 8 + uy, 2, 1, c.outline);
    px(b, 13, 8 + uy, 2, 1, c.outline);
  } else if (mood === 'happy') {
    px(b, 10, 7 + uy, 1, 1, c.outline);
    px(b, 11, 6 + uy, 1, 1, c.outline);
    px(b, 13, 6 + uy, 1, 1, c.outline);
    px(b, 14, 7 + uy, 1, 1, c.outline);
  } else if (mood === 'sad') {
    px(b, 10, 8 + uy, 1, 1, c.outline);
    px(b, 13, 8 + uy, 1, 1, c.outline);
    px(b, 14, 9 + uy, 1, 1, c.metalLight);
  } else {
    px(b, 10, 7 + uy, 1, 1, c.outline);
    px(b, 13, 7 + uy, 1, 1, c.outline);
  }

  // Red cap with a flat brim and a round cream emblem.
  px(b, 8, 2 + uy, 8, 3, c.outline);
  px(b, 9, 2 + uy, 6, 2, c.primary);
  px(b, 7, 5 + uy, 10, 1, c.outline);
  px(b, 8, 5 + uy, 8, 1, c.primary);
  px(b, 11, 2 + uy, 3, 2, c.cream);
  px(b, 12, 2 + uy, 1, 1, c.primaryLight);

  // Arms: white gloves; a raised fist while celebrating.
  if (phase === 'celebrating') {
    px(b, 6, 12 + uy, 2, 5, c.outline);
    px(b, 6, 12 + uy, 2, 3, c.primary);
    px(b, 6, 15 + uy, 2, 2, c.cream);
    px(b, 16, 5 + uy, 2, 6, c.outline);
    px(b, 16, 5 + uy, 2, 4, c.primary);
    px(b, 15, 2 + uy, 4, 3, c.outline);
    px(b, 16, 2 + uy, 2, 2, c.cream);
  } else {
    const s = workArmShift;
    // The working fist drops a clear 2px on the work frame instead of only
    // shortening the shoulder.
    const rdrop = 2 * s;
    px(b, 6, 12 + uy + s, 2, 6 - s, c.outline);
    px(b, 6, 12 + uy + s, 2, 4 - s, c.primary);
    px(b, 6, 16 + uy, 2, 2, c.cream);
    px(b, 16, 12 + uy + rdrop, 2, 6, c.outline);
    px(b, 16, 12 + uy + rdrop, 2, 4, c.primary);
    px(b, 16, 16 + uy + rdrop, 2, 2, c.cream);
  }

  drawPhaseFx(b, c, { phase, mood, y: uy, hx: 18, hy: 12 + uy }, frame);
}

// ─── 3. Green Quest ────────────────────────────────────────────────────

/** Adventure hero: floppy green cap, blond fringe, tunic, sword and shield. */
export function drawGameGreenQuest(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const p = drawCrewBody(b, c, phase, workArmShift, (s, y, mood) => {
    // Pointed ears.
    px(s, 7, y + 6, 1, 2, c.outline);
    px(s, 16, y + 6, 1, 2, c.outline);
    px(s, 7, y + 6, 1, 1, c.skin);
    px(s, 16, y + 7, 1, 1, c.skin);
    // Head.
    px(s, 8, y + 3, 8, 8, c.outline);
    px(s, 8, y + 4, 8, 6, c.skin);
    drawFace(s, y + 5, mood, c.outline, c.mouth);
    // Blond fringe.
    px(s, 8, y + 4, 8, 1, c.accent);
    px(s, 9, y + 5, 1, 1, c.accent);
    px(s, 14, y + 5, 1, 1, c.accent);
    // Long floppy pointed cap trailing to the left.
    px(s, 8, y + 2, 8, 2, c.outline);
    px(s, 8, y + 2, 8, 1, c.primary);
    px(s, 3, y + 3, 5, 3, c.outline);
    px(s, 4, y + 3, 4, 2, c.primary);
    px(s, 0, y + 5, 3, 3, c.outline);
    px(s, 1, y + 6, 2, 2, c.primaryDark);
  });
  const { y, hx: x, hy } = p;
  // Belt with a lamp buckle.
  px(b, 9, y + 16, 6, 1, c.woodDark);
  px(b, 11, y + 16, 2, 1, c.lamp);
  // Round shield strapped to the other arm.
  px(b, 4, y + 11, 5, 1, c.outline);
  px(b, 3, y + 12, 7, 4, c.outline);
  px(b, 4, y + 16, 5, 1, c.outline);
  px(b, 4, y + 12, 5, 4, c.primaryDark);
  px(b, 5, y + 12, 4, 1, c.accent);
  px(b, 5, y + 13, 3, 2, c.tool);
  // Small sword in the working hand.
  px(b, x, hy - 7, 1, 9, c.tool);
  px(b, x, hy - 7, 1, 1, c.white);
  px(b, x - 1, hy + 1, 3, 1, c.woodDark);
  px(b, x, hy + 2, 1, 2, c.woodDark);
  drawPhaseFx(b, c, p, frame);
}

// ─── 4. Blue Dash ──────────────────────────────────────────────────────

/** Speedy blue hedgehog (non-human): swept-back spikes and red sneakers. */
export function drawGameBlueDash(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const mood = moodForPhase(phase);
  const y = slump(mood);
  const s = workArmShift;

  px(b, 5, 22, 14, 1, c.shadow);

  // Three swept-back spikes to the left.
  px(b, 3, y + 5, 5, 2, c.outline);
  px(b, 4, y + 5, 4, 1, c.primaryLight);
  px(b, 1, y + 8, 6, 2, c.outline);
  px(b, 2, y + 8, 5, 1, c.primaryLight);
  px(b, 3, y + 11, 5, 2, c.outline);
  px(b, 4, y + 11, 4, 1, c.primaryLight);

  // Big blue head.
  px(b, 6, y + 4, 12, 11, c.outline);
  px(b, 7, y + 5, 10, 9, c.primary);
  px(b, 7, y + 5, 10, 1, c.primaryLight);

  // Cream muzzle and nose.
  px(b, 10, y + 11, 6, 3, c.outline);
  px(b, 11, y + 11, 4, 2, c.tool);
  px(b, 11, y + 11, 2, 1, c.outline);

  // Large eyes.
  px(b, 9, y + 7, 2, 3, c.tool);
  px(b, 13, y + 7, 2, 3, c.tool);
  if (mood === 'sleep') {
    px(b, 9, y + 8, 2, 1, c.outline);
    px(b, 13, y + 8, 2, 1, c.outline);
  } else if (mood === 'happy') {
    px(b, 9, y + 7, 1, 1, c.outline);
    px(b, 10, y + 6, 1, 1, c.outline);
    px(b, 13, y + 6, 1, 1, c.outline);
    px(b, 14, y + 7, 1, 1, c.outline);
  } else if (mood === 'sad') {
    px(b, 9, y + 8, 1, 1, c.outline);
    px(b, 13, y + 8, 1, 1, c.outline);
    px(b, 14, y + 9, 1, 1, c.metalLight);
  } else {
    px(b, 9, y + 7, 1, 2, c.outline);
    px(b, 13, y + 7, 1, 2, c.outline);
  }
  px(b, 9, y + 7, 1, 1, c.white);
  px(b, 13, y + 7, 1, 1, c.white);

  // Short body with a cream belly.
  px(b, 8, 15, 8, 4, c.outline);
  px(b, 9, 15, 6, 3, c.primary);
  px(b, 9, 17, 6, 1, c.tool);

  // Short arms; raised while celebrating, tapping while working.
  if (phase === 'celebrating') {
    px(b, 5, y + 6, 2, 4, c.outline);
    px(b, 5, y + 6, 1, 3, c.primary);
    px(b, 17, y + 6, 2, 4, c.outline);
    px(b, 18, y + 6, 1, 3, c.primary);
  } else {
    px(b, 6, 15 + s, 2, 3 - s, c.outline);
    px(b, 6, 15, 1, 2, c.primary);
    px(b, 16, 15, 2, 3, c.outline);
    px(b, 17, 15, 1, 2, c.primary);
  }

  // Red sneakers with a white strap; the front foot taps with workArmShift.
  px(b, 7, 19 - s, 4, 3, c.outline);
  px(b, 8, 19 - s, 3, 1, c.accent);
  px(b, 8, 21 - s, 1, 1, c.white);
  px(b, 13, 19, 4, 3, c.outline);
  px(b, 13, 19, 3, 1, c.accent);
  px(b, 14, 21, 1, 1, c.white);

  drawPhaseFx(b, c, { phase, mood, y, hx: 17, hy: y + 8 }, frame);
}

// ─── 5. Block Miner ────────────────────────────────────────────────────

/** Stout bearded dwarf-miner: brown helmet with a lamp and a heavy pickaxe. */
export function drawGameBlockMiner(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const p = drawCrewBody(b, c, phase, workArmShift, (s, y, mood) => {
    // Face.
    px(s, 8, y + 5, 8, 7, c.outline);
    px(s, 8, y + 6, 8, 5, c.skin);
    drawFace(s, y + 6, mood, c.outline, c.mouth);
    // Round brown helmet with a headlamp.
    px(s, 7, y + 1, 10, 1, c.outline);
    px(s, 6, y + 2, 12, 3, c.outline);
    px(s, 7, y + 2, 10, 2, c.primary);
    px(s, 7, y + 2, 10, 1, c.primaryLight);
    px(s, 10, y + 3, 4, 1, c.accent);
    px(s, 11, y + 3, 2, 1, c.lampLight);
    px(s, 5, y + 5, 14, 1, c.outline);
    px(s, 6, y + 5, 12, 1, c.primary);
    // Big bushy beard over the chest.
    px(s, 6, y + 10, 12, 5, c.outline);
    px(s, 7, y + 10, 10, 4, c.metalLight);
    px(s, 8, y + 12, 8, 2, c.metalLight);
  });
  const { y, hx: x, hy } = p;
  // Wide belt over a stout belly.
  px(b, 7, y + 15, 10, 2, c.outline);
  px(b, 8, y + 15, 8, 1, c.woodDark);
  px(b, 10, y + 15, 4, 1, c.accent);
  // Heavy pickaxe resting on the shoulder, swinging with workArmShift.
  px(b, x - 1, hy - 5, 2, 9, c.woodDark);
  px(b, x - 4, hy - 7, 9, 3, c.outline);
  px(b, x - 3, hy - 6, 7, 1, c.tool);
  px(b, x - 4, hy - 6, 1, 2, c.tool);
  px(b, x + 3, hy - 6, 1, 2, c.tool);
  drawPhaseFx(b, c, p, frame);
}

// ─── 6. Space Bounty ───────────────────────────────────────────────────

/** Armored space hunter (non-human): round helmet, green visor, arm cannon. */
export function drawGameSpaceBounty(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const mood = moodForPhase(phase);
  const y = slump(mood);
  const s = workArmShift;

  px(b, 5, 22, 14, 1, c.shadow);

  // Chunky torso with a chest plate.
  px(b, 8, y + 11, 8, 7, c.outline);
  px(b, 9, y + 12, 6, 5, c.primary);
  px(b, 9, y + 12, 6, 1, c.primaryLight);
  px(b, 10, y + 14, 4, 2, c.accentDark);
  px(b, 11, y + 14, 2, 1, c.accent);

  // Rounded power-suit helmet with a green visor.
  px(b, 8, y + 2, 8, 1, c.outline);
  px(b, 7, y + 3, 10, 1, c.outline);
  px(b, 6, y + 4, 12, 8, c.outline);
  px(b, 7, y + 12, 10, 1, c.outline);
  px(b, 7, y + 4, 10, 8, c.primary);
  px(b, 7, y + 4, 10, 1, c.primaryLight);
  px(b, 8, y + 6, 8, 4, c.outline);
  px(b, 8, y + 7, 8, 2, c.accent);
  px(b, 9, y + 7, 2, 1, c.lampLight);
  if (mood === 'sleep') {
    px(b, 10, y + 7, 2, 1, c.primaryDark);
    px(b, 13, y + 7, 2, 1, c.primaryDark);
  } else if (mood === 'happy') {
    px(b, 10, y + 8, 1, 1, c.primaryDark);
    px(b, 11, y + 7, 1, 1, c.primaryDark);
    px(b, 13, y + 7, 1, 1, c.primaryDark);
    px(b, 14, y + 8, 1, 1, c.primaryDark);
  } else if (mood === 'sad') {
    px(b, 10, y + 8, 1, 1, c.primaryDark);
    px(b, 13, y + 8, 1, 1, c.primaryDark);
    px(b, 14, y + 9, 1, 1, c.metalLight);
  } else {
    px(b, 10, y + 7, 1, 2, c.primaryDark);
    px(b, 13, y + 7, 1, 2, c.primaryDark);
  }

  // Big round shoulder pads.
  px(b, 4, y + 9, 3, 1, c.outline);
  px(b, 3, y + 10, 5, 5, c.outline);
  px(b, 4, y + 10, 3, 4, c.primaryDark);
  px(b, 17, y + 9, 3, 1, c.outline);
  px(b, 16, y + 10, 5, 5, c.outline);
  px(b, 17, y + 10, 3, 4, c.primaryDark);

  // Legs and armored boots.
  px(b, 8, 17, 8, 4, c.outline);
  px(b, 9, 17, 2, 3, c.primaryDark);
  px(b, 13, 17, 2, 3, c.primaryDark);
  px(b, 7, 20, 4, 2, c.outline);
  px(b, 8, 20, 2, 1, c.metal);
  px(b, 13, 20, 4, 2, c.outline);
  px(b, 14, 20, 2, 1, c.metal);

  // Left gloved arm.
  px(b, 5, y + 13, 3, 5, c.outline);
  px(b, 6, y + 13, 1, 3, c.primary);
  px(b, 6, y + 16, 1, 2, c.metal);

  // Right arm cannon; recoils with workArmShift, raised while celebrating.
  if (phase === 'celebrating') {
    px(b, 15, y + 6, 3, 7, c.outline);
    px(b, 16, y + 6, 1, 5, c.primary);
    px(b, 16, y + 3, 6, 4, c.outline);
    px(b, 17, y + 4, 4, 2, c.metal);
    px(b, 21, y + 4, 1, 2, c.tool);
  } else {
    px(b, 15, y + 13 + s, 7, 4, c.outline);
    px(b, 16, y + 14 + s, 4, 2, c.metal);
    px(b, 20, y + 14 + s, 2, 2, c.tool);
    px(b, 21, y + 14 + s, 1, 1, c.accentDark);
  }

  drawPhaseFx(b, c, { phase, mood, y, hx: 19, hy: y + 14 }, frame);
}

// ─── 7. Arcade Ghost ───────────────────────────────────────────────────

/** Arcade maze ghost (non-human): dome top, wavy skirt, big cream eyes. */
export function drawGameArcadeGhost(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const mood = moodForPhase(phase);
  const sad = mood === 'sad';
  const body = sad ? c.primaryLight : c.primary;
  // Dejection flattens the dome instead of dropping the whole figure: the
  // skirt always ends on row 21, the ground row, with the shadow on row 22.
  const domeTop = sad ? 9 : 8;

  px(b, 6, 22, 12, 1, c.shadow);

  // Dome-topped body anchored on the skirt: rows 8..18, then the wavy hem.
  px(b, 9, domeTop, 6, 1, c.outline);
  px(b, 7, domeTop + 1, 10, 1, c.outline);
  px(b, 6, domeTop + 2, 12, 1, c.outline);
  px(b, 5, domeTop + 3, 14, 19 - domeTop - 3, c.outline);
  px(b, 8, domeTop + 1, 8, 1, body);
  px(b, 7, domeTop + 2, 10, 1, body);
  px(b, 6, domeTop + 3, 12, 19 - domeTop - 3, body);
  if (!sad) px(b, 7, domeTop + 2, 10, 1, c.primaryLight);

  // Wavy three-tooth skirt on rows 19..21: at least one tooth always reaches
  // row 21 and the tooth lengths alternate with frame.
  const f = frame % 2;
  const teeth: Array<[number, boolean]> = [
    [5, f === 0],
    [10, f === 1],
    [15, f === 0],
  ];
  for (const [tx, long] of teeth) {
    const h = long ? 3 : 2;
    px(b, tx, 19, 4, h, c.outline);
    px(b, tx + 1, 19, 2, h - 1, body);
  }

  // Two big cream eyes with blue pupils that look left or right.
  px(b, 7, 12, 3, 4, c.accent);
  px(b, 13, 12, 3, 4, c.accent);
  if (mood === 'sleep') {
    px(b, 7, 13, 3, 1, c.outline);
    px(b, 13, 13, 3, 1, c.outline);
  } else if (mood === 'happy') {
    px(b, 7, 14, 1, 1, c.outline);
    px(b, 8, 13, 1, 1, c.outline);
    px(b, 9, 14, 1, 1, c.outline);
    px(b, 13, 14, 1, 1, c.outline);
    px(b, 14, 13, 1, 1, c.outline);
    px(b, 15, 14, 1, 1, c.outline);
  } else if (sad) {
    px(b, 8, 14, 2, 2, c.tool);
    px(b, 13, 14, 2, 2, c.tool);
  } else {
    const look = workArmShift > 0 ? 8 : 7;
    px(b, look, 13, 1, 2, c.tool);
    px(b, look + 6, 13, 1, 2, c.tool);
  }

  // Mouth.
  if (sad) {
    px(b, 11, 18, 2, 1, c.outline);
    px(b, 10, 17, 1, 1, c.outline);
    px(b, 13, 17, 1, 1, c.outline);
  } else {
    px(b, 10, 18, 4, 1, c.outline);
    px(b, 9, 17, 1, 1, c.outline);
    px(b, 14, 17, 1, 1, c.outline);
  }

  drawPhaseFx(b, c, { phase, mood, y: sad ? 1 : 0, hx: 17, hy: 13 }, frame);
}

// ─── 8. Rune Mage ──────────────────────────────────────────────────────

/** Wizard: bent purple hat with lamp stars, grey beard, robe, orb staff. */
export function drawGameRuneMage(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const p = drawCrewBody(b, c, phase, workArmShift, (s, y, mood) => {
    // Face.
    px(s, 8, y + 5, 8, 7, c.outline);
    px(s, 9, y + 5, 6, 6, c.skin);
    drawFace(s, y + 6, mood, c.outline, c.mouth);
    // Tall bent purple pointy hat with lamp star dots.
    px(s, 9, y + 0, 6, 1, c.outline);
    px(s, 10, y + 0, 4, 1, c.primaryDark);
    px(s, 8, y + 1, 8, 3, c.outline);
    px(s, 9, y + 1, 6, 3, c.primary);
    px(s, 4, y + 3, 4, 2, c.outline);
    px(s, 5, y + 3, 3, 1, c.primaryDark);
    px(s, 7, y + 4, 10, 1, c.outline);
    px(s, 8, y + 4, 8, 1, c.primary);
    px(s, 10, y + 2, 1, 1, c.lamp);
    px(s, 13, y + 1, 1, 1, c.lampLight);
    px(s, 12, y + 3, 1, 1, c.lamp);
    // Long grey beard.
    px(s, 8, y + 11, 8, 5, c.outline);
    px(s, 9, y + 11, 6, 4, c.metalLight);
    px(s, 10, y + 14, 4, 1, c.metalLight);
  });
  const { y, hx: x } = p;
  const lift = phase === 'working' ? workArmShift : 0;
  // Purple robe to the ground.
  const robeTop = y + 14;
  px(b, 7, robeTop, 10, 22 - robeTop, c.outline);
  px(b, 8, robeTop, 8, 21 - robeTop, c.primary);
  px(b, 8, robeTop, 8, 1, c.primaryLight);
  px(b, 9, 20, 6, 1, c.primaryDark);
  // Wooden staff with a glowing orb that pulses with frame.
  px(b, x, y + 5 - lift, 1, 15, c.woodDark);
  px(b, x - 1, y + 3 - lift, 3, 3, c.outline);
  px(b, x, y + 4 - lift, 1, 1, frame % 2 === 0 ? c.accent : c.lampLight);
  drawPhaseFx(b, c, p, frame);
}

// ─── 9. Shadow Ninja ───────────────────────────────────────────────────

/** Ninja: dark hood with a skin eye slit, fluttering scarf, dark katana. */
export function drawGameShadowNinja(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const p = drawCrewBody(b, c, phase, workArmShift, (s, y, mood) => {
    // Full dark hood.
    px(s, 7, y + 2, 10, 10, c.outline);
    px(s, 8, y + 3, 8, 8, c.primary);
    px(s, 8, y + 3, 8, 1, c.primaryLight);
    // Skin eye slit.
    px(s, 8, y + 7, 8, 2, c.outline);
    px(s, 9, y + 7, 6, 1, c.skin);
    if (mood === 'sleep') {
      px(s, 10, y + 7, 2, 1, c.outline);
      px(s, 13, y + 7, 2, 1, c.outline);
    } else if (mood === 'happy') {
      px(s, 10, y + 6, 1, 1, c.outline);
      px(s, 13, y + 6, 1, 1, c.outline);
    } else if (mood === 'sad') {
      px(s, 10, y + 7, 1, 1, c.outline);
      px(s, 13, y + 7, 1, 1, c.outline);
      px(s, 14, y + 8, 1, 1, c.metalLight);
    } else {
      px(s, 10, y + 7, 1, 1, c.outline);
      px(s, 13, y + 7, 1, 1, c.outline);
    }
  });
  const { y, hx: x, hy } = p;
  // Red headband tails fluttering to the left.
  const f = frame % 2;
  px(b, 5, y + 3, 3, 1, c.accent);
  px(b, 3, y + 4 + f, 3, 1, c.accent);
  px(b, 1, y + 5 - f, 3, 1, c.accent);
  // Katana in the working hand.
  px(b, x, hy - 7, 1, 9, c.tool);
  px(b, x, hy - 7, 1, 1, c.white);
  px(b, x - 1, hy + 1, 3, 1, c.outline);
  px(b, x, hy + 2, 1, 2, c.primaryDark);
  drawPhaseFx(b, c, p, frame);
}

// ─── 10. Slime King ────────────────────────────────────────────────────

/** Slime monster king (non-human): glossy teardrop blob under a gold crown. */
export function drawGameSlimeKing(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const mood = moodForPhase(phase);
  const y = slump(mood);
  const squash = phase === 'working' && workArmShift > 0 ? 1 : 0;

  px(b, 6, 22, 12, 1, c.shadow);

  // Teardrop silhouette: narrow tip, wide base, resting on row 21.
  const widths = [2, 2, 4, 6, 8, 10, 12, 14, 14, 16, 16, 16, 14, 14, 12, 10];
  const top = 7 + y - squash;
  for (let i = 0; i < widths.length; i++) {
    const r = top + i;
    if (r > 21) continue;
    const w = widths[i];
    px(b, Math.round(12 - w / 2), r, w, 1, c.outline);
  }
  for (let i = 1; i < widths.length - 1; i++) {
    const r = top + i;
    if (r > 20) continue;
    const w = widths[i] - 2;
    if (w <= 0) continue;
    px(b, Math.round(12 - w / 2), r, w, 1, c.primary);
  }

  // 2px gloss highlight.
  px(b, 8, top + 4, 2, 2, c.white);

  // Big friendly eyes with a smile.
  const ey = top + 5;
  if (mood === 'sleep') {
    px(b, 9, ey + 1, 2, 1, c.outline);
    px(b, 13, ey + 1, 2, 1, c.outline);
  } else if (mood === 'sad') {
    px(b, 9, ey + 1, 2, 2, c.outline);
    px(b, 13, ey + 1, 2, 2, c.outline);
  } else {
    px(b, 9, ey, 2, 3, c.outline);
    px(b, 13, ey, 2, 3, c.outline);
  }
  px(b, 9, ey, 1, 1, c.white);
  px(b, 13, ey, 1, 1, c.white);
  if (mood === 'sad') {
    px(b, 11, ey + 4, 2, 1, c.outline);
    px(b, 10, ey + 3, 1, 1, c.outline);
    px(b, 13, ey + 3, 1, 1, c.outline);
  } else {
    px(b, 10, ey + 4, 4, 1, c.outline);
    px(b, 9, ey + 3, 1, 1, c.outline);
    px(b, 14, ey + 3, 1, 1, c.outline);
  }

  // Gold crown seated on the pointed tip: the band touches the tip outline so
  // no empty row shows between cap and slime, and the whole crown follows the
  // workArmShift squash/stretch with the slime it sits on.
  px(b, 9, top - 4, 1, 1, c.accent);
  px(b, 11, top - 4, 2, 1, c.accent);
  px(b, 14, top - 4, 1, 1, c.accent);
  px(b, 8, top - 3, 8, 2, c.outline);
  px(b, 9, top - 3, 6, 2, c.accent);
  px(b, 11, top - 2, 2, 1, c.tool);
  px(b, 8, top - 1, 8, 1, c.accent);

  drawPhaseFx(b, c, { phase, mood, y, hx: 17, hy: ey }, frame);
}
