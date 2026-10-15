/**
 * Pet worker skin overview generator (dev tool, never shipped).
 *
 * Renders every catalogued worker skin in each animation state into a set of
 * PNG contact sheets for visual acceptance:
 *
 *   artifacts/pet-skin-overview/{native,game,crew,all}.png
 *   artifacts/pet-skin-overview/legend.json
 *
 * Pure Node: no Electron, no PixiJS, no canvas package. Sprites are rasterized
 * by a local duck-typed sink that mirrors the PixelBuilder contract used by
 * drawPixelMascot, scaled up with nearest-neighbour sampling, and encoded with
 * node:zlib (RGBA, filter type 0, CRC32).
 *
 * Sections:
 *   native = kind `official`, grouped by client (codebuddy, codex, claude, dsh);
 *            each client contributes its native mascot then its crew outfit.
 *   game   = kind `classic`  (video-game character themes).
 *   crew   = kind `original` (the Lamplight crew).
 *
 * Run:
 *   pnpm --filter @wrenyard/desktop exec tsx tools/pet/scripts/skin-overview.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import type { PixelBuilder } from '../../../src/pet/render';
import { drawPixelMascot } from '../../../src/pet/features/worker/scene/skin-drawer';
import { SKIN_CATALOG, type WorkerSkinCatalogEntry } from '../../../src/pet/features/worker/appearance';
import { normalizeAppearance } from '../../../src/pet/features/worker/scene/palette';
import type { Appearance, Phase, WorkerClient } from '../../../src/pet/shared/snapshot';

// ─── Layout tokens ─────────────────────────────────────────────────────

/** Local sprite box drawn by drawPixelMascot (matches worker/scene/index.ts). */
const BOX_W = 40;
const BOX_H = 44;
/** Nearest-neighbour upscale per source pixel. */
const SCALE = 4;
const CELL_W = BOX_W * SCALE;
const CELL_H = BOX_H * SCALE;
/** 1px grid gap between cells. */
const GAP = 1;
const MARGIN = 8;
const LABEL_GAP = 12;
const SECTION_GAP = 16;
/** activityOffset is pinned to 0 for every column. */
const ACTIVITY_OFFSET = 0;

const BACKGROUND = '#EDE2C4';
const CELL_BG = '#F3EBD5';
const LABEL_INK = '#2E2018';
const TITLE_INK = '#8A5A2E';

// ─── Columns ───────────────────────────────────────────────────────────

interface OverviewColumn {
  phase: Phase;
  frame: number;
  workArmShift: number;
}

/**
 * The Phase union (apps/desktop/src/main/daemon-client/agent-types.ts) is
 * exactly `working | sleeping | celebrating | dejected` — there is no
 * idle/waiting-like phase a drawer can receive, so no extra column is added.
 */
const COLUMNS: readonly OverviewColumn[] = [
  { phase: 'working', frame: 0, workArmShift: 0 },
  { phase: 'working', frame: 1, workArmShift: 1 },
  { phase: 'sleeping', frame: 0, workArmShift: 0 },
  { phase: 'sleeping', frame: 1, workArmShift: 0 },
  { phase: 'celebrating', frame: 0, workArmShift: 0 },
  { phase: 'celebrating', frame: 1, workArmShift: 0 },
  { phase: 'dejected', frame: 0, workArmShift: 0 },
];

// ─── Embedded 3x5 pixel font ───────────────────────────────────────────

const FONT_W = 3;
const FONT_H = 5;
/** Font-pixel gap between glyphs, in font pixels. */
const FONT_SPACING = 1;

const FONT: Readonly<Record<string, readonly string[]>> = {
  ' ': ['...', '...', '...', '...', '...'],
  '-': ['...', '...', '###', '...', '...'],
  ':': ['...', '.#.', '...', '.#.', '...'],
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '.##', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#.#', '###', '###', '#.#', '#.#'],
  N: ['#.#', '##.', '#.#', '#.#', '#.#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '##.', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#.#', '#.#', '###', '###', '#.#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
};

// ─── Color parsing ─────────────────────────────────────────────────────

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseRgb(input: string): Rgb {
  const value = input.trim();
  if (value.startsWith('#')) {
    let hex = value.slice(1);
    if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
    return {
      r: parseInt(hex.slice(0, 2), 16) || 0,
      g: parseInt(hex.slice(2, 4), 16) || 0,
      b: parseInt(hex.slice(4, 6), 16) || 0,
    };
  }
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (match) {
    const parts = match[1].split(',').map((part) => part.trim());
    return {
      r: parseInt(parts[0], 10) || 0,
      g: parseInt(parts[1], 10) || 0,
      b: parseInt(parts[2], 10) || 0,
    };
  }
  return { r: 0, g: 0, b: 0 };
}

function parseAlpha(input: string, fallback: number): number {
  const value = input.trim();
  const match = value.match(/rgba\(([^)]+)\)/);
  if (match) {
    const parts = match[1].split(',').map((part) => part.trim());
    if (parts[3] !== undefined) {
      const parsed = parseFloat(parts[3]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

// ─── Sprite sink (duck-typed PixelBuilder) ─────────────────────────────

interface RectSink {
  rect(x: number, y: number, width: number, height: number, color: string, alpha?: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
}

/**
 * Minimal RGBA sink mirroring PixelBuilder: integer rects clipped to the
 * buffer, source-over alpha blending. clearRect resets pixels to transparent.
 */
class SpriteSink implements RectSink {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  rect(x: number, y: number, width: number, height: number, color: string, alpha = 1): void {
    const rectX = Math.round(x);
    const rectY = Math.round(y);
    const rectW = Math.round(width);
    const rectH = Math.round(height);
    if (rectW <= 0 || rectH <= 0) return;

    const x0 = Math.max(0, rectX);
    const y0 = Math.max(0, rectY);
    const x1 = Math.min(this.width, rectX + rectW);
    const y1 = Math.min(this.height, rectY + rectH);
    if (x1 <= x0 || y1 <= y0) return;

    const source = Math.max(0, Math.min(1, alpha)) * parseAlpha(color, 1);
    if (source <= 0) return;

    const { r, g, b } = parseRgb(color);
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        this.blend(px, py, r, g, b, source);
      }
    }
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, x0 + Math.round(width));
    const y1 = Math.min(this.height, y0 + Math.round(height));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const index = (py * this.width + px) * 4;
        this.data[index] = 0;
        this.data[index + 1] = 0;
        this.data[index + 2] = 0;
        this.data[index + 3] = 0;
      }
    }
  }

  private blend(x: number, y: number, r: number, g: number, b: number, source: number): void {
    const index = (y * this.width + x) * 4;
    const dstAlpha = this.data[index + 3] / 255;
    const outAlpha = source + dstAlpha * (1 - source);
    if (outAlpha <= 0) {
      this.data[index] = 0;
      this.data[index + 1] = 0;
      this.data[index + 2] = 0;
      this.data[index + 3] = 0;
      return;
    }
    const dstWeight = dstAlpha * (1 - source);
    this.data[index] = Math.round((r * source + this.data[index] * dstWeight) / outAlpha);
    this.data[index + 1] = Math.round((g * source + this.data[index + 1] * dstWeight) / outAlpha);
    this.data[index + 2] = Math.round((b * source + this.data[index + 2] * dstWeight) / outAlpha);
    this.data[index + 3] = Math.round(outAlpha * 255);
  }
}

// ─── Opaque canvas ─────────────────────────────────────────────────────

class Canvas {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;

  constructor(width: number, height: number, background: string) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
    this.fillRect(0, 0, width, height, background);
  }

  fillRect(x: number, y: number, width: number, height: number, color: string, alpha = 1): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, x0 + Math.round(width));
    const y1 = Math.min(this.height, y0 + Math.round(height));
    if (x1 <= x0 || y1 <= y0) return;
    const { r, g, b } = parseRgb(color);
    const source = Math.max(0, Math.min(1, alpha)) * parseAlpha(color, 1);
    if (source <= 0) return;
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        this.blend(px, py, r, g, b, source);
      }
    }
  }

  /** Nearest-neighbour blit of a sprite, scaling each source pixel by `scale`. */
  blit(sprite: SpriteSink, destX: number, destY: number, scale: number): void {
    for (let sy = 0; sy < sprite.height; sy += 1) {
      for (let sx = 0; sx < sprite.width; sx += 1) {
        const index = (sy * sprite.width + sx) * 4;
        const alpha = sprite.data[index + 3] / 255;
        if (alpha <= 0) continue;
        const r = sprite.data[index];
        const g = sprite.data[index + 1];
        const b = sprite.data[index + 2];
        for (let oy = 0; oy < scale; oy += 1) {
          for (let ox = 0; ox < scale; ox += 1) {
            this.blend(destX + sx * scale + ox, destY + sy * scale + oy, r, g, b, alpha);
          }
        }
      }
    }
  }

  /** Opaque copy of another canvas at (destX, destY). */
  drawImage(source: Canvas, destX: number, destY: number): void {
    for (let y = 0; y < source.height; y += 1) {
      const ty = destY + y;
      if (ty < 0 || ty >= this.height) continue;
      for (let x = 0; x < source.width; x += 1) {
        const tx = destX + x;
        if (tx < 0 || tx >= this.width) continue;
        const from = (y * source.width + x) * 4;
        const to = (ty * this.width + tx) * 4;
        source.data.copy(this.data, to, from, from + 4);
      }
    }
  }

  private blend(x: number, y: number, r: number, g: number, b: number, source: number): void {
    const index = (y * this.width + x) * 4;
    const dstAlpha = this.data[index + 3] / 255;
    const outAlpha = source + dstAlpha * (1 - source);
    if (outAlpha <= 0) return;
    const dstWeight = dstAlpha * (1 - source);
    this.data[index] = Math.round((r * source + this.data[index] * dstWeight) / outAlpha);
    this.data[index + 1] = Math.round((g * source + this.data[index + 1] * dstWeight) / outAlpha);
    this.data[index + 2] = Math.round((b * source + this.data[index + 2] * dstWeight) / outAlpha);
    this.data[index + 3] = Math.round(outAlpha * 255);
  }
}

// ─── Text ──────────────────────────────────────────────────────────────

function charAdvance(scale: number): number {
  return (FONT_W + FONT_SPACING) * scale;
}

function textWidth(text: string, scale: number): number {
  if (text.length === 0) return 0;
  return text.length * charAdvance(scale) - FONT_SPACING * scale;
}

function drawText(
  canvas: Canvas,
  text: string,
  x: number,
  y: number,
  color: string,
  scale: number,
): void {
  let cursor = x;
  for (const char of text.toUpperCase()) {
    const glyph = FONT[char] ?? FONT[' '];
    for (let gy = 0; gy < FONT_H; gy += 1) {
      const row = glyph[gy];
      for (let gx = 0; gx < FONT_W; gx += 1) {
        if (row[gx] === '#') {
          canvas.fillRect(cursor + gx * scale, y + gy * scale, scale, scale, color);
        }
      }
    }
    cursor += charAdvance(scale);
  }
}

// ─── Sprite rendering ──────────────────────────────────────────────────

function renderSprite(entry: WorkerSkinCatalogEntry, column: OverviewColumn): SpriteSink {
  const appearance: Appearance = normalizeAppearance({
    profile: entry.id,
    profileLabel: entry.name,
    skin: entry,
  });
  const sink = new SpriteSink(BOX_W, BOX_H);
  drawPixelMascot(
    sink as unknown as PixelBuilder,
    appearance,
    column.phase,
    column.frame,
    ACTIVITY_OFFSET,
    column.workArmShift,
  );
  return sink;
}

// ─── Sections ──────────────────────────────────────────────────────────

interface SectionRow {
  entry: WorkerSkinCatalogEntry;
}

interface SectionSpec {
  id: 'native' | 'game' | 'crew';
  title: string;
  file: string;
  rows: SectionRow[];
}

const CLIENT_ORDER: readonly WorkerClient[] = ['codebuddy', 'codex', 'claude', 'dsh'];

function officialRows(): SectionRow[] {
  const rows: SectionRow[] = [];
  for (const client of CLIENT_ORDER) {
    for (const entry of SKIN_CATALOG) {
      if (entry.kind === 'official' && entry.client === client) rows.push({ entry });
    }
  }
  return rows;
}

function rowsOfKind(kind: WorkerSkinCatalogEntry['kind']): SectionRow[] {
  return SKIN_CATALOG.filter((entry) => entry.kind === kind).map((entry) => ({ entry }));
}

const SECTION_SPECS: readonly SectionSpec[] = [
  { id: 'native', title: 'NATIVE CLIENT MASCOTS', file: 'native.png', rows: officialRows() },
  { id: 'game', title: 'VIDEO GAME CHARACTERS', file: 'game.png', rows: rowsOfKind('classic') },
  { id: 'crew', title: 'LAMPLIGHT CREW', file: 'crew.png', rows: rowsOfKind('original') },
];

const LABEL_SCALE = 2;
const TITLE_SCALE = 3;
const TITLE_GAP = 8;

function buildSectionCanvas(spec: SectionSpec): Canvas {
  const labelAdvance = charAdvance(LABEL_SCALE);
  const maxLabelChars = spec.rows.reduce((max, row) => Math.max(max, row.entry.id.length), 0);
  const labelWidth = maxLabelChars * labelAdvance - FONT_SPACING * LABEL_SCALE;

  const cellsWidth = COLUMNS.length * CELL_W + (COLUMNS.length - 1) * GAP;
  const width = MARGIN * 2 + labelWidth + LABEL_GAP + cellsWidth;

  const titleHeight = FONT_H * TITLE_SCALE;
  const rowsHeight = spec.rows.length * (CELL_H + GAP) - GAP;
  const height = MARGIN * 2 + titleHeight + TITLE_GAP + rowsHeight;

  const canvas = new Canvas(width, height, BACKGROUND);
  drawText(canvas, spec.title, MARGIN, MARGIN, TITLE_INK, TITLE_SCALE);

  const rowsTop = MARGIN + titleHeight + TITLE_GAP;
  const labelY = Math.floor((CELL_H - FONT_H * LABEL_SCALE) / 2);
  const cellsX = MARGIN + labelWidth + LABEL_GAP;

  spec.rows.forEach((row, rowIndex) => {
    const rowY = rowsTop + rowIndex * (CELL_H + GAP);
    drawText(canvas, row.entry.id, MARGIN, rowY + labelY, LABEL_INK, LABEL_SCALE);

    COLUMNS.forEach((column, columnIndex) => {
      const cellX = cellsX + columnIndex * (CELL_W + GAP);
      canvas.fillRect(cellX, rowY, CELL_W, CELL_H, CELL_BG);
      canvas.blit(renderSprite(row.entry, column), cellX, rowY, SCALE);
    });
  });

  return canvas;
}

// ─── PNG encoding (RGBA, filter 0, CRC32) ──────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(canvas: Canvas): Buffer {
  const width = canvas.width;
  const height = canvas.height;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    canvas.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Entry point ───────────────────────────────────────────────────────

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '../../..');
const outputDir = path.join(desktopRoot, 'artifacts', 'pet-skin-overview');

const columnKeys = COLUMNS.map(
  (column) => `${column.phase}#${column.frame}${column.workArmShift ? `+arm${column.workArmShift}` : ''}`,
);

function main(): void {
  fs.mkdirSync(outputDir, { recursive: true });

  const sectionCanvases = SECTION_SPECS.map((spec) => ({
    spec,
    canvas: buildSectionCanvas(spec),
  }));

  const report: { file: string; width: number; height: number }[] = [];
  const sections: Record<string, unknown> = {};

  for (const { spec, canvas } of sectionCanvases) {
    const file = path.join(outputDir, spec.file);
    fs.writeFileSync(file, encodePng(canvas));
    report.push({ file: spec.file, width: canvas.width, height: canvas.height });

    sections[spec.id] = {
      title: spec.title,
      file: spec.file,
      rows: spec.rows.map((row) => ({
        id: row.entry.id,
        name: row.entry.name,
        kind: row.entry.kind,
        client: row.entry.client ?? null,
        columns: COLUMNS.map((column) => ({
          phase: column.phase,
          frame: column.frame,
          workArmShift: column.workArmShift,
          activityOffset: ACTIVITY_OFFSET,
        })),
      })),
    };
  }

  const allWidth = Math.max(...sectionCanvases.map(({ canvas }) => canvas.width));
  const allHeight =
    sectionCanvases.reduce((sum, { canvas }) => sum + canvas.height, 0) +
    SECTION_GAP * (sectionCanvases.length - 1);
  const all = new Canvas(allWidth, allHeight, BACKGROUND);
  let cursorY = 0;
  for (const { canvas } of sectionCanvases) {
    all.drawImage(canvas, 0, cursorY);
    cursorY += canvas.height + SECTION_GAP;
  }
  fs.writeFileSync(path.join(outputDir, 'all.png'), encodePng(all));
  report.push({ file: 'all.png', width: all.width, height: all.height });

  const legend = {
    schemaVersion: 'pet-skin-overview/v1',
    generatedBy: 'tools/pet/scripts/skin-overview.ts',
    spriteBox: { width: BOX_W, height: BOX_H },
    pixelScale: SCALE,
    gridGap: GAP,
    background: BACKGROUND,
    columnKeys,
    sections,
  };
  fs.writeFileSync(path.join(outputDir, 'legend.json'), `${JSON.stringify(legend, null, 2)}\n`);

  process.stdout.write(`output directory: ${path.relative(process.cwd(), outputDir)}\n`);
  for (const item of report) {
    process.stdout.write(`  ${item.file}  ${item.width}x${item.height}\n`);
  }
  process.stdout.write(`  legend.json  ${Object.keys(sections).length} sections\n`);
}

main();
