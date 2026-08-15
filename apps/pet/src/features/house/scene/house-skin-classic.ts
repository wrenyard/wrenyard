/**
 * Classic 48x40 procedural house with the Lamplight Workshop palette.
 *
 * Preserves the committed classic geometry as its semantic baseline:
 * - Two floors / one platform at y=21
 * - Two 1F windows at (13,26) and (31,26)
 * - Grounded open/closed 5x9 door bounds at x=21..25, y=30..38
 * - Chimney behind roof at x=14..18, smoke above at y=0..3
 * - 10 fixed 4x3 token slots (lower row y=18, upper row y=15)
 *
 * Palette:
 *   ink #2E2018, woodDark #5B3218, wood #8A5A2E, woodLight #B17D3E,
 *   plaster #F5EBD4, plasterShade #D9CBA8, lamp #FFC94D,
 *   terracotta #C44E3A, terracottaDark #9E3A2C
 */

import { PixelBuilder, type PixelProgram, type RenderPixel } from '../../../render';

export const HOUSE_PX_W = 48;
export const HOUSE_PX_H = 40;

export const CRATES_MAX = 10;
export const TOKENS_PER_CRATE = 50_000_000;

// ── Palette ─────────────────────────────────────────────────────────
const ink = '#2E2018';
const woodDark = '#5B3218';
const wood = '#8A5A2E';
const woodLight = '#B17D3E';
const plaster = '#F5EBD4';
const plasterShade = '#D9CBA8';
const lamp = '#FFC94D';
const terracotta = '#C44E3A';
const terracottaDark = '#9E3A2C';

// ── Geometry ────────────────────────────────────────────────────────

type HouseRun = readonly [start: number, pixels: string];

function houseRow(...runs: HouseRun[]): string {
  const cells = Array<string>(HOUSE_PX_W).fill(' ');
  for (const [start, pixels] of runs) {
    for (let i = 0; i < pixels.length; i++) cells[start + i] = pixels[i] ?? ' ';
  }
  return cells.join('');
}

function stemRow(left: number, right: number, shadowWidth: number, carveDoor = false): string {
  const cells = Array<string>(HOUSE_PX_W).fill(' ');
  const shadowRight = Math.min(left + shadowWidth - 1, right);
  for (let x = left; x <= right; x++) cells[x] = x <= shadowRight ? 'S' : 'W';
  if (carveDoor) {
    for (let x = 22; x <= 24; x++) cells[x] = ' ';
  }
  return cells.join('');
}

const HOUSE_DATA = [
  houseRow(),                      // 0
  houseRow(),                      // 1
  houseRow(),                      // 2
  houseRow(),                      // 3
  houseRow([22, 'HYYH']),          // 4 — ridge: terracottaDark + terracotta
  houseRow([20, 'HYYYYH']),        // 5
  houseRow([18, 'HYYYYYYH']),      // 6
  houseRow([16, 'HYYYYYYYYH']),    // 7
  houseRow([13, 'HYYYYYYYYYYYYH']), // 8
  houseRow([11, 'HYYYYYYYYYYYYYYH']), // 9
  houseRow([9, 'H'.repeat(30)]),   // 10 — dark eave
  stemRow(10, 37, 3),              // 11
  stemRow(10, 37, 3),              // 12
  stemRow(10, 37, 3),              // 13
  stemRow(10, 37, 3),              // 14
  stemRow(10, 37, 3),              // 15
  stemRow(10, 37, 3),              // 16
  stemRow(10, 37, 3),              // 17
  stemRow(10, 37, 3),              // 18
  stemRow(10, 37, 3),              // 19
  stemRow(10, 37, 3),              // 20
  stemRow(10, 37, 3),              // 21 — platform level
  stemRow(10, 37, 3),              // 22
  stemRow(10, 37, 3),              // 23
  stemRow(10, 37, 3),              // 24
  stemRow(10, 37, 3),              // 25
  stemRow(10, 37, 3),              // 26
  stemRow(10, 37, 3),              // 27
  stemRow(10, 37, 3),              // 28
  stemRow(10, 37, 3),              // 29
  stemRow(10, 37, 3),              // 30 — door lintel level
  stemRow(10, 37, 3, true),        // 31 — door center carved
  stemRow(10, 37, 3, true),        // 32
  stemRow(10, 37, 3, true),        // 33
  stemRow(10, 37, 3, true),        // 34
  stemRow(10, 37, 3, true),        // 35
  stemRow(10, 37, 3, true),        // 36
  stemRow(10, 37, 3, true),        // 37
  stemRow(10, 37, 3, true),        // 38
  houseRow(),                      // 39 — baseline handled in details
];

const HOUSE_COLORS: Record<string, string | undefined> = {
  Y: terracotta,
  H: terracottaDark,
  O: terracottaDark,
  W: plaster,
  S: plasterShade,
};

export function buildClassicPixelProgram(): PixelProgram {
  const builder = new PixelBuilder(HOUSE_PX_W, HOUSE_PX_H);
  for (let y = 0; y < HOUSE_DATA.length; y++) {
    const row = HOUSE_DATA[y] ?? '';
    for (let x = 0; x < HOUSE_PX_W; x++) {
      const color = HOUSE_COLORS[row[x] ?? ' '];
      if (color) builder.rect(x, y, 1, 1, color);
    }
  }
  drawClassicPixelDetails(builder);
  return builder.build();
}

export function updateClassicHouseSprite(
  sprite: RenderPixel,
  x: number,
  y: number,
  scale: number,
  running: boolean,
  runningWorkerCount: number,
  totalTokens: number,
  _dispatchCount: number,
): void {
  const program = buildClassicPixelProgram();
  const builder = new PixelBuilder(HOUSE_PX_W, HOUSE_PX_H);

  // Chimney underlay
  builder.rect(14, 2, 6, 1, woodDark);
  builder.rect(15, 2, 4, 9, wood);
  builder.rect(16, 2, 2, 9, woodLight);

  for (const rect of program.rects) {
    builder.rect(rect.x, rect.y, rect.width, rect.height, rect.color);
  }

  if (running && runningWorkerCount > 0) {
    drawClassicSmoke(builder);
    drawClassicOpenDoor(builder);
  } else {
    drawClassicClosedDoor(builder);
  }

  drawClassicTokenTier(builder, totalTokens);

  sprite.setProgram(builder.build());
  sprite.setPosition(Math.round(x * scale), Math.round(y * scale));
  sprite.setScale(scale);
  sprite.setVisible(true);
}

function drawClassicSmoke(builder: PixelBuilder): void {
  builder.rect(14, 0, 3, 1, '#D8D2C3');
  builder.rect(16, 1, 2, 1, '#ECE6D7');
}

function drawClassicOpenDoor(builder: PixelBuilder): void {
  builder.rect(21, 30, 5, 1, woodDark);
  builder.rect(21, 31, 1, 8, woodDark);
  builder.rect(25, 31, 1, 8, woodDark);
}

function drawClassicClosedDoor(builder: PixelBuilder): void {
  builder.rect(21, 30, 5, 9, woodDark);
  builder.rect(22, 31, 1, 7, woodLight);
  builder.rect(24, 32, 1, 6, wood);
  builder.rect(25, 37, 1, 1, lamp);
}

function drawClassicTokenTier(builder: PixelBuilder, totalTokens: number): void {
  const crateCount = Math.min(Math.max(0, Math.floor(totalTokens / TOKENS_PER_CRATE)), CRATES_MAX);
  for (let i = 0; i < crateCount; i++) {
    const rowIndex = i % 5;
    const cy = i < 5 ? 18 : 15;
    const cx = 12 + 5 * rowIndex;
    drawClassicCrate(builder, cx, cy);
  }
}

function drawClassicCrate(builder: PixelBuilder, cx: number, cy: number): void {
  // 4x3 readable wooden crate with ink packing detail
  // Row 0: wood light top
  builder.rect(cx, cy, 4, 1, woodLight);
  // Row 1: ink stripe between wood planks
  builder.rect(cx, cy + 1, 4, 1, wood);
  // Row 2: wood base
  builder.rect(cx, cy + 2, 4, 1, woodDark);
  // Packing detail: ink cross
  builder.rect(cx + 1, cy + 1, 1, 1, ink);
  builder.rect(cx + 2, cy + 1, 1, 1, ink);
}

function drawClassicPixelDetails(builder: PixelBuilder): void {
  // Cap lobes removed — this is a pointed terracotta roof, not a mushroom
  // Platform divider
  builder.rect(11, 21, 26, 1, plasterShade);

  drawClassicWindow(builder, 13, 26);
  drawClassicWindow(builder, 31, 26);

  // Yellow portal outside dynamic door bounds
  builder.rect(22, 28, 3, 1, lamp);
  builder.rect(21, 29, 5, 1, lamp);
  builder.rect(20, 30, 1, 9, wood);
  builder.rect(26, 30, 1, 9, wood);

  // Baseline ground
  builder.rect(9, 39, 30, 1, woodDark);
}

function drawClassicWindow(builder: PixelBuilder, wx: number, wy: number): void {
  builder.rect(wx, wy, 4, 6, woodDark);
  builder.rect(wx + 1, wy + 1, 1, 2, lamp);
  builder.rect(wx + 2, wy + 1, 1, 2, lamp);
  builder.rect(wx + 1, wy + 4, 1, 1, lamp);
  builder.rect(wx + 2, wy + 4, 1, 1, lamp);
}
