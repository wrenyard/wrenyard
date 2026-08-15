/**
 * Mushroom 48x40 procedural house skin.
 *
 * Preserves 48x40, two floors, y=21 platform, two 1F windows, door bounds,
 * chimney/smoke, and exact 10 milestone slots. Uses a warm mushroom palette.
 *
 * Palette:
 *   cap #E9A13B, capLight #F2C14E, capDark #C77B2E,
 *   plaster #F5EBD4, plasterShade #D9CBA8, ink #2E2018,
 *   woodDark #5B3218, wood #8A5A2E, woodLight #B17D3E,
 *   lamp #FFC94D, lampDeep #E8A33D
 */

import { PixelBuilder, type PixelProgram, type RenderPixel } from '../../../render';

export const HOUSE_PX_W = 48;
export const HOUSE_PX_H = 40;

export const CRATES_MAX = 10;
export const TOKENS_PER_CRATE = 50_000_000;

// ── Palette ─────────────────────────────────────────────────────────
const cap = '#E9A13B';
const capLight = '#F2C14E';
const capDark = '#C77B2E';
const plaster = '#F5EBD4';
const plasterShade = '#D9CBA8';
const ink = '#2E2018';
const woodDark = '#5B3218';
const wood = '#8A5A2E';
const woodLight = '#B17D3E';
const lamp = '#FFC94D';
const lampDeep = '#E8A33D';

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
  houseRow(),
  houseRow(),
  houseRow(),
  houseRow(),
  houseRow([23, 'H'.repeat(7)]),
  houseRow([20, 'H'.repeat(6)], [26, 'Y'.repeat(8)]),
  houseRow([16, 'H'.repeat(8)], [24, 'Y'.repeat(13)]),
  houseRow([12, 'H'.repeat(9)], [21, 'Y'.repeat(19)]),
  houseRow([9, 'O'.repeat(7)], [16, 'H'.repeat(8)], [24, 'Y'.repeat(19)]),
  houseRow([6, 'O'.repeat(10)], [16, 'H'.repeat(7)], [23, 'Y'.repeat(22)]),
  houseRow([4, 'O'.repeat(11)], [15, 'H'.repeat(5)], [20, 'Y'.repeat(26)]),
  houseRow([2, 'O'.repeat(12)], [14, 'Y'.repeat(33)]),
  houseRow([2, 'O'.repeat(10)], [12, 'Y'.repeat(35)]),
  houseRow([3, 'O'.repeat(8)], [11, 'Y'.repeat(36)]),
  houseRow([5, 'O'.repeat(7)], [12, 'Y'.repeat(35)]),
  stemRow(12, 35, 3),
  stemRow(11, 36, 3),
  stemRow(10, 37, 3),
  stemRow(10, 37, 4),
  stemRow(9, 38, 4),
  stemRow(9, 38, 4),
  stemRow(9, 38, 5),
  stemRow(8, 39, 5),
  stemRow(8, 39, 5),
  stemRow(8, 39, 5),
  stemRow(7, 40, 5),
  stemRow(7, 40, 5),
  stemRow(7, 40, 5),
  stemRow(7, 40, 5),
  stemRow(7, 40, 5),
  stemRow(8, 39, 5),
  stemRow(8, 39, 5, true),
  stemRow(8, 39, 5, true),
  stemRow(8, 39, 4, true),
  stemRow(8, 39, 4, true),
  stemRow(9, 38, 4, true),
  stemRow(9, 38, 4, true),
  stemRow(10, 37, 3, true),
  stemRow(12, 35, 3, true),
  houseRow(),
];

const HOUSE_COLORS: Record<string, string | undefined> = {
  Y: cap,
  H: capLight,
  O: capDark,
  W: plaster,
  S: plasterShade,
};

// Three restrained 2x2 plaster spots across the cap (y=1..2, spaced across x)
const CAP_SPOTS: readonly [x: number, y: number][] = [
  [6, 1],
  [20, 1],
  [34, 1],
];

export function buildMushroomPixelProgram(): PixelProgram {
  const builder = new PixelBuilder(HOUSE_PX_W, HOUSE_PX_H);
  for (let y = 0; y < HOUSE_DATA.length; y++) {
    const row = HOUSE_DATA[y] ?? '';
    for (let x = 0; x < HOUSE_PX_W; x++) {
      const color = HOUSE_COLORS[row[x] ?? ' '];
      if (color) builder.rect(x, y, 1, 1, color);
    }
  }
  drawMushroomPixelDetails(builder);
  // Add restrained plaster spots across the cap
  for (const [sx, sy] of CAP_SPOTS) {
    builder.rect(sx, sy, 2, 2, plaster);
  }
  return builder.build();
}

export function updateMushroomHouseSprite(
  sprite: RenderPixel,
  x: number,
  y: number,
  scale: number,
  running: boolean,
  runningWorkerCount: number,
  totalTokens: number,
  _dispatchCount: number,
): void {
  const program = buildMushroomPixelProgram();
  const builder = new PixelBuilder(HOUSE_PX_W, HOUSE_PX_H);

  // Chimney underlay — mushroom-toned wood
  builder.rect(14, 2, 6, 1, woodDark);
  builder.rect(15, 2, 4, 9, wood);
  builder.rect(16, 2, 2, 9, woodLight);

  for (const rect of program.rects) {
    builder.rect(rect.x, rect.y, rect.width, rect.height, rect.color);
  }

  if (running && runningWorkerCount > 0) {
    drawMushroomSmoke(builder);
    drawMushroomOpenDoor(builder);
  } else {
    drawMushroomClosedDoor(builder);
  }

  drawMushroomTokenTier(builder, totalTokens);

  sprite.setProgram(builder.build());
  sprite.setPosition(Math.round(x * scale), Math.round(y * scale));
  sprite.setScale(scale);
  sprite.setVisible(true);
}

function drawMushroomSmoke(builder: PixelBuilder): void {
  builder.rect(14, 0, 3, 1, '#D8D2C3');
  builder.rect(16, 1, 2, 1, '#ECE6D7');
}

function drawMushroomOpenDoor(builder: PixelBuilder): void {
  builder.rect(22, 30, 3, 1, woodDark);
  builder.rect(21, 31, 1, 8, woodDark);
  builder.rect(25, 31, 1, 8, woodDark);
}

function drawMushroomClosedDoor(builder: PixelBuilder): void {
  builder.rect(22, 30, 3, 1, woodDark);
  builder.rect(21, 31, 5, 8, woodDark);
  builder.rect(22, 31, 1, 7, woodLight);
  builder.rect(24, 32, 1, 6, wood);
  builder.rect(25, 37, 1, 1, lamp);
}

function drawMushroomTokenTier(builder: PixelBuilder, totalTokens: number): void {
  const crateCount = Math.min(Math.max(0, Math.floor(totalTokens / TOKENS_PER_CRATE)), CRATES_MAX);
  for (let i = 0; i < crateCount; i++) {
    const rowIndex = i % 5;
    const my = i < 5 ? 18 : 15;
    const mx = 12 + 5 * rowIndex;
    drawMiniMushroom(builder, mx, my);
  }
}

function drawMiniMushroom(builder: PixelBuilder, mx: number, my: number): void {
  // 4x3 high-contrast mini mushroom: amber cap, ink outline, readable wood/plaster stem
  // Row 0: 2px centered amber cap top
  builder.rect(mx + 1, my, 2, 1, capLight);
  // Row 1: 4px cap body with ink keyline edges
  builder.rect(mx, my + 1, 4, 1, cap);
  builder.rect(mx, my + 1, 1, 1, ink);
  builder.rect(mx + 3, my + 1, 1, 1, ink);
  // Row 2: 2px wood/plaster stem
  builder.rect(mx + 1, my + 2, 1, 1, ink);
  builder.rect(mx + 2, my + 2, 1, 1, woodLight);
}

function drawMushroomPixelDetails(builder: PixelBuilder): void {
  // Cap lobes
  builder.rect(4, 15, 7, 1, capDark);
  builder.rect(37, 15, 10, 1, capLight);
  builder.rect(5, 16, 5, 1, capDark);
  builder.rect(40, 16, 5, 1, capLight);

  // Platform divider
  builder.rect(11, 21, 26, 1, '#F0E8D8');

  drawMushroomWindow(builder, 13, 26);
  drawMushroomWindow(builder, 31, 26);

  // Portal outside dynamic door bounds
  builder.rect(22, 28, 3, 1, '#FFE06A');
  builder.rect(21, 29, 5, 1, lampDeep);
  builder.rect(20, 30, 1, 9, '#E7C247');
  builder.rect(26, 30, 1, 9, '#E7C247');

  // Baseline ground
  builder.rect(11, 39, 26, 1, '#6F4D2D');
  builder.rect(10, 39, 1, 1, '#B9A17A');
  builder.rect(37, 39, 1, 1, '#B9A17A');
}

function drawMushroomWindow(builder: PixelBuilder, wx: number, wy: number): void {
  builder.rect(wx, wy, 4, 6, woodDark);
  builder.rect(wx + 1, wy + 1, 1, 2, '#FFE06A');
  builder.rect(wx + 2, wy + 1, 1, 2, lamp);
  builder.rect(wx + 1, wy + 4, 1, 1, lamp);
  builder.rect(wx + 2, wy + 4, 1, 1, '#FFE06A');
}
