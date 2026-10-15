/**
 * Native client mascot skins (official).
 *
 * Four hand-drawn pixel mascots for the real AI coding clients:
 *  - drawNativeClaudeCrab  Claude Code's "Clawd" crab.
 *  - drawNativeCodeBuddy   the CodeBuddy robot.
 *  - drawNativeCodex       Codex as a terminal-window creature.
 *  - drawNativeDshFish     DeepSeek's "big fish" whale for the dsh client.
 *
 * All four share the crew local space: the figure stands on row 21 with its
 * ground shadow on row 22, centred between columns 11 and 12. Every silhouette
 * carries a 1px ink outline and flat Lamplight colors from skinPalette /
 * CREW_COLORS. Phases map to moods (sleep / happy / sad / open); working uses
 * workArmShift on a limb, celebrating raises the limbs, and drawPhaseFx adds
 * the shared sleep Zs and celebration twinkles.
 */

import type { Appearance, Phase } from '../../../shared/snapshot';
import { CREW_COLORS, skinPalette } from './palette';
import { drawPhaseFx, moodForPhase, px, type Pose, type RectSink } from './skin-drawer';

/** Upper-body drop shared by every native mascot: 1 dozing, 2 dejected. */
function dropFor(phase: Phase): number {
  const mood = moodForPhase(phase);
  return mood === 'sad' ? 2 : mood === 'sleep' ? 1 : 0;
}

/**
 * Paint one per-row silhouette with a clean 1px ink outline: a pixel is ink
 * when any 4-neighbour falls outside the silhouette, otherwise it takes the
 * fill color. `spans[i]` holds the horizontal intervals of row `topRow + i`.
 */
function silhouette(
  b: RectSink,
  topRow: number,
  spans: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
  fill: string,
  outline: string,
): void {
  const inside = (x: number, r: number): boolean => {
    const row = spans[r - topRow];
    if (!row) return false;
    return row.some(([left, right]) => x >= left && x <= right);
  };
  for (let i = 0; i < spans.length; i++) {
    const r = topRow + i;
    for (const [left, right] of spans[i]) {
      for (let x = left; x <= right; x++) {
        const edge = !inside(x - 1, r) || !inside(x + 1, r) || !inside(x, r - 1) || !inside(x, r + 1);
        px(b, x, r, 1, 1, edge ? outline : fill);
      }
    }
  }
}

// ─── Claude Code crab ("Clawd") ────────────────────────────────────────

/** Claude Code's flat orange crab: shell body, wide ink eyes, pincer arms. */
export function drawNativeClaudeCrab(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const mood = moodForPhase(phase);
  const y = dropFor(phase);
  const s = workArmShift;
  const celebrating = phase === 'celebrating';

  px(b, 5, 22, 14, 1, c.shadow);

  // Four short planted legs (row 18 to row 21), two per side with a gap.
  for (const lx of [6, 9, 14, 17]) {
    px(b, lx, 18, 1, 4, c.outline);
    px(b, lx, 19, 1, 1, c.primaryDark);
  }

  // Flat 18x10 shell (x 3..20, bottom on row 17) with a lit top edge.
  const shellTop = 8 + y;
  px(b, 3, shellTop, 18, 10, c.outline);
  px(b, 4, shellTop + 1, 16, 8, c.primary);
  px(b, 4, shellTop + 1, 16, 1, c.primaryLight);
  px(b, 4, shellTop + 8, 16, 1, c.primaryDark);

  // Two separated 2x3 ink eyes; plain expressions draw no mouth and no
  // central dark block.
  const ey = shellTop + 2;
  if (mood === 'sleep') {
    px(b, 7, ey + 2, 2, 1, c.outline);
    px(b, 15, ey + 2, 2, 1, c.outline);
  } else if (mood === 'happy') {
    px(b, 6, ey + 1, 1, 1, c.outline);
    px(b, 7, ey, 1, 1, c.outline);
    px(b, 8, ey, 1, 1, c.outline);
    px(b, 9, ey + 1, 1, 1, c.outline);
    px(b, 14, ey + 1, 1, 1, c.outline);
    px(b, 15, ey, 1, 1, c.outline);
    px(b, 16, ey, 1, 1, c.outline);
    px(b, 17, ey + 1, 1, 1, c.outline);
  } else if (mood === 'sad') {
    px(b, 7, ey + 1, 2, 3, c.outline);
    px(b, 15, ey + 1, 2, 3, c.outline);
    px(b, 6, ey + 4, 1, 1, c.accent);
  } else {
    px(b, 7, ey, 2, 3, c.outline);
    px(b, 15, ey, 2, 3, c.outline);
  }

  // Short pincer arms at mid height: 3px reach, 2px high, 1px accent tip.
  const armRow = 12 + y;
  const raise = celebrating ? 3 : 0;
  const rs = phase === 'working' ? s : 0;
  px(b, 0, armRow - raise - 1, 3, 1, c.outline);
  px(b, 0, armRow - raise, 1, 2, c.accent);
  px(b, 1, armRow - raise, 2, 2, c.primary);
  px(b, 0, armRow - raise + 2, 3, 1, c.outline);
  px(b, 21, armRow - raise + rs - 1, 3, 1, c.outline);
  px(b, 23, armRow - raise + rs, 1, 2, c.accent);
  px(b, 21, armRow - raise + rs, 2, 2, c.primary);
  px(b, 21, armRow - raise + rs + 2, 3, 1, c.outline);

  const pose: Pose = { phase, mood, y, hx: 21, hy: armRow + 1 };
  drawPhaseFx(b, c, pose, frame);
}

// ─── CodeBuddy robot ───────────────────────────────────────────────────

/** CodeBuddy's friendly grey bot: visor screen, teal pill eyes, antenna bulb. */
export function drawNativeCodeBuddy(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const mood = moodForPhase(phase);
  const y = dropFor(phase);
  const s = workArmShift;
  const celebrating = phase === 'celebrating';

  px(b, 5, 22, 14, 1, c.shadow);

  // Two stubby feet planted on the ground.
  px(b, 7, 20, 4, 2, c.outline);
  px(b, 8, 20, 2, 1, c.primaryDark);
  px(b, 13, 20, 4, 2, c.outline);
  px(b, 14, 20, 2, 1, c.primaryDark);

  // Compact body with a teal chest light.
  const bodyTop = 12 + y;
  px(b, 7, bodyTop, 10, 8, c.outline);
  px(b, 8, bodyTop + 1, 8, 6, c.primary);
  px(b, 8, bodyTop + 1, 8, 1, c.primaryLight);
  px(b, 8, bodyTop + 6, 8, 1, c.primaryDark);
  px(b, 10, bodyTop + 3, 2, 2, c.accent);

  // Rounded-square head (corners cut by 1px) with a plated top edge.
  const headTop = 2 + y;
  px(b, 6, headTop, 12, 1, c.outline);
  px(b, 5, headTop + 1, 14, 8, c.outline);
  px(b, 6, headTop + 9, 12, 1, c.outline);
  px(b, 6, headTop + 1, 12, 8, c.primary);
  px(b, 6, headTop + 1, 12, 1, c.primaryLight);

  // Dark visor screen with a soft top sheen.
  px(b, 7, headTop + 2, 10, 6, c.panel);
  px(b, 8, headTop + 3, 8, 1, c.panelLight);

  // Glowing teal pill eyes that change with mood.
  const ey = headTop + 3;
  if (mood === 'sleep') {
    px(b, 8, ey + 1, 2, 1, c.accentDark);
    px(b, 14, ey + 1, 2, 1, c.accentDark);
  } else if (mood === 'happy') {
    px(b, 8, ey + 1, 1, 1, c.accent);
    px(b, 9, ey, 1, 1, c.accent);
    px(b, 14, ey, 1, 1, c.accent);
    px(b, 15, ey + 1, 1, 1, c.accent);
  } else if (mood === 'sad') {
    px(b, 8, ey + 1, 2, 2, c.accentDark);
    px(b, 14, ey + 1, 2, 2, c.accentDark);
    px(b, 8, ey + 3, 1, 1, CREW_COLORS.cream);
  } else {
    px(b, 8, ey, 2, 3, c.accent);
    px(b, 14, ey, 2, 3, c.accent);
  }

  // Round ear pods on both sides.
  px(b, 4, headTop + 3, 2, 3, c.outline);
  px(b, 5, headTop + 4, 1, 1, c.accentDark);
  px(b, 19, headTop + 3, 2, 3, c.outline);
  px(b, 18, headTop + 4, 1, 1, c.accentDark);

  // Antenna with a bulb that blinks every other frame.
  px(b, 11, y, 1, 1, frame % 2 === 0 ? c.accent : c.accentDark);
  px(b, 11, y + 1, 1, 1, c.outline);

  // Stubby arms with round hands, seated against the body outline so no
  // background shows between shoulder and torso; right hand taps while
  // working and both arms raise when celebrating.
  const armTop = 14 + y;
  const raise = celebrating ? 3 : 0;
  const rs = phase === 'working' ? s : 0;
  px(b, 4, armTop - raise, 3, 5, c.outline);
  px(b, 5, armTop - raise + 1, 1, 3, c.primary);
  px(b, 3, armTop - raise + 4, 4, 3, c.outline);
  px(b, 4, armTop - raise + 5, 2, 1, c.tool);
  px(b, 17, armTop - raise + rs, 3, 5, c.outline);
  px(b, 18, armTop - raise + rs + 1, 1, 3, c.primary);
  px(b, 17, armTop - raise + rs + 4, 4, 3, c.outline);
  px(b, 18, armTop - raise + rs + 5, 2, 1, c.tool);

  const pose: Pose = { phase, mood, y, hx: 20, hy: armTop };
  drawPhaseFx(b, c, pose, frame);
}

// ─── Codex CLI terminal ────────────────────────────────────────────────

/** Codex as a chunky terminal window with a `>` prompt and blinking cursor. */
export function drawNativeCodex(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const mood = moodForPhase(phase);
  const y = dropFor(phase);
  const s = workArmShift;
  const celebrating = phase === 'celebrating';
  const cursorOn = phase === 'working' ? s > 0 : frame % 2 === 0;

  px(b, 4, 22, 16, 1, c.shadow);

  // Two short legs.
  px(b, 6, 19, 3, 3, c.outline);
  px(b, 7, 19, 1, 2, c.tool);
  px(b, 15, 19, 3, 3, c.outline);
  px(b, 16, 19, 1, 2, c.tool);

  // Window frame with a 2px title bar and three 1px window dots.
  px(b, 4, 7 + y, 16, 12, c.outline);
  px(b, 5, 8 + y, 14, 10, c.primary);
  px(b, 5, 8 + y, 14, 2, c.primaryLight);
  px(b, 7, 8 + y, 1, 1, CREW_COLORS.terracotta);
  px(b, 9, 8 + y, 1, 1, CREW_COLORS.lamp);
  px(b, 11, 8 + y, 1, 1, CREW_COLORS.moss);

  // Deep screen interior.
  px(b, 6, 10 + y, 12, 7, c.primaryDark);

  // Screen face: happy shows two `^` eyes; sad drops the prompt and adds a tear.
  if (mood === 'happy') {
    px(b, 7, 13 + y, 1, 1, c.accent);
    px(b, 8, 12 + y, 1, 1, c.accent);
    px(b, 9, 13 + y, 1, 1, c.accent);
    px(b, 13, 13 + y, 1, 1, c.accent);
    px(b, 14, 12 + y, 1, 1, c.accent);
    px(b, 15, 13 + y, 1, 1, c.accent);
  } else if (mood === 'sleep') {
    px(b, 8, 13 + y, 2, 1, c.accentDark);
  } else {
    const sh = mood === 'sad' ? 1 : 0;
    px(b, 7, 11 + y + sh, 1, 1, c.accent);
    px(b, 8, 12 + y + sh, 1, 1, c.accent);
    px(b, 7, 13 + y + sh, 1, 1, c.accent);
    if (cursorOn) px(b, 10, 13 + y + sh, 2, 1, c.accent);
    if (mood === 'sad') px(b, 12, 15 + y, 1, 1, c.accent);
  }

  // Cable-like side arms; right arm drops while working, both raise.
  const faceRow = 12 + y;
  const raise = celebrating ? 4 : 0;
  const rs = phase === 'working' ? s : 0;
  px(b, 2, faceRow - raise, 2, 3, c.outline);
  px(b, 3, faceRow - raise + 1, 1, 1, c.tool);
  px(b, 20, faceRow - raise + rs, 2, 3, c.outline);
  px(b, 20, faceRow - raise + rs + 1, 1, 1, c.tool);

  const pose: Pose = { phase, mood, y, hx: 7, hy: 13 + y };
  drawPhaseFx(b, c, pose, frame);
}

// ─── DeepSeek "big fish" whale ─────────────────────────────────────────

/**
 * DeepSeek's whale silhouette, one entry per row from `DSH_TOP_ROW`: the
 * rounded 8/12/14/16/16/16/14/10 px body rests on row 21, its rear tapers into
 * a narrow tailstock and a forked fluke that rises 6px above the back.
 */
const DSH_TOP_ROW = 8;
const DSH_ROWS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[17, 19], [21, 23]], // row 8  forked fluke tips (notch at column 20)
  [[17, 19], [21, 23]], // row 9
  [[17, 23]], // row 10 fluke base
  [[19, 22]], // row 11 tailstock
  [[19, 22]], // row 12
  [[18, 21]], // row 13
  [[7, 14], [18, 21]], // row 14 back top, tailstock behind it
  [[5, 16], [18, 21]], // row 15
  [[4, 20]], // row 16 rear merges with the tailstock base
  [[4, 19]], // row 17
  [[4, 19]], // row 18
  [[4, 19]], // row 19
  [[4, 17]], // row 20
  [[5, 14]], // row 21 belly on the ground
];

/** DeepSeek's chubby blue whale: upturned forked tail, cream belly, big eye. */
export function drawNativeDshFish(
  b: RectSink,
  appearance: Appearance,
  phase: Phase,
  frame: number,
  workArmShift: number,
): void {
  const c = skinPalette(appearance);
  const mood = moodForPhase(phase);
  const s = workArmShift;
  const celebrating = phase === 'celebrating';

  px(b, 5, 22, 13, 1, c.shadow);

  // Blunt head on the left, rounded back and belly, fluke curling up on the
  // right. The body keeps its ground row in every state; mood shows on the
  // face so the belly never sinks below row 21.
  silhouette(b, DSH_TOP_ROW, DSH_ROWS, c.primary, c.outline);

  // Lit back edge on the row below the ink crest.
  px(b, 7, DSH_TOP_ROW + 7, 8, 1, c.primaryLight);

  // Inner shade down the tailstock.
  px(b, 20, 12, 1, 4, c.primaryDark);

  // Cream belly arc following the lower edge (its lowest pixels are row 20).
  px(b, 7, 19, 3, 1, c.accent);
  px(b, 6, 20, 5, 1, c.accent);

  // Short curved mouth line at the front of the head.
  px(b, 6, 18, 2, 1, c.outline);
  px(b, 5, 19, 1, 1, c.outline);

  // One big ink eye with a 1px cream highlight.
  const ey = 16;
  if (mood === 'sleep') {
    px(b, 7, ey + 1, 2, 1, c.outline);
  } else if (mood === 'happy') {
    px(b, 6, ey + 1, 1, 1, c.outline);
    px(b, 7, ey, 1, 1, c.outline);
    px(b, 8, ey, 1, 1, c.outline);
    px(b, 9, ey + 1, 1, 1, c.outline);
  } else if (mood === 'sad') {
    px(b, 7, ey + 1, 2, 2, c.outline);
    px(b, 6, ey + 1, 1, 1, c.accent);
  } else {
    px(b, 7, ey, 2, 2, c.outline);
    px(b, 7, ey, 1, 1, CREW_COLORS.cream);
  }

  // Small 3x2 pectoral fin in the lower middle: lifts while working, points
  // up when celebrating.
  if (celebrating) {
    px(b, 12, 16, 2, 3, c.primaryDark);
  } else {
    px(b, 11, 19 - (phase === 'working' ? s : 0), 3, 2, c.primaryDark);
  }

  // Celebration water spout above the blowhole.
  if (celebrating) {
    px(b, 7, 12, 1, 3, c.primaryLight);
    px(b, 6, 10, 1, 1, CREW_COLORS.cream);
    px(b, 8, 11, 1, 1, c.primaryLight);
  }

  const pose: Pose = { phase, mood, y: 0, hx: 12, hy: celebrating ? 16 : 19 };
  drawPhaseFx(b, c, pose, frame);
}
