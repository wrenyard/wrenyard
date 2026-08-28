/** Menu-bar sized Wrenyard product mark. 18pt @2x. */
export const TRAY_ICON_SIZE = 18;
export const TRAY_ICON_SCALE = 2;

const PIXEL_SIZE = TRAY_ICON_SIZE * TRAY_ICON_SCALE;
const SAMPLE_GRID = 3;

interface BirdShape {
  body: readonly [number, number, number, number];
  head: readonly [number, number, number];
  eye: readonly [number, number, number];
  beak: readonly [number, number, number, number, number, number];
}

/** Three wrens on one branch, reduced from the full-colour Desktop app mark. */
const BIRDS: readonly BirdShape[] = [
  {
    body: [9, 20, 4.2, 6.7],
    head: [7.6, 13.8, 3.4],
    eye: [6.8, 13.1, 0.72],
    beak: [4.6, 12.9, 1.5, 14, 4.8, 14.8],
  },
  {
    body: [18.2, 18.8, 5, 8.4],
    head: [20.2, 9.7, 4.2],
    eye: [21.2, 8.9, 0.78],
    beak: [23.8, 8.7, 29, 10, 23.8, 11.1],
  },
  {
    body: [28, 20.7, 4.2, 6.7],
    head: [29.2, 14.1, 3.4],
    eye: [30, 13.4, 0.72],
    beak: [32, 13.1, 35.2, 14.3, 32, 15],
  },
];

export function renderTrayIconBitmap(): {
  pixelWidth: number;
  pixelHeight: number;
  scale: number;
  buffer: Buffer;
} {
  const buffer = Buffer.alloc(PIXEL_SIZE * PIXEL_SIZE * 4);
  for (let y = 0; y < PIXEL_SIZE; y += 1) {
    for (let x = 0; x < PIXEL_SIZE; x += 1) {
      let covered = 0;
      for (let sy = 0; sy < SAMPLE_GRID; sy += 1) {
        for (let sx = 0; sx < SAMPLE_GRID; sx += 1) {
          const sampleX = x + (sx + 0.5) / SAMPLE_GRID;
          const sampleY = y + (sy + 0.5) / SAMPLE_GRID;
          if (insideWrenyardMark(sampleX, sampleY)) covered += 1;
        }
      }
      if (covered === 0) continue;
      const index = (y * PIXEL_SIZE + x) * 4;
      buffer[index + 3] = Math.round(covered / (SAMPLE_GRID * SAMPLE_GRID) * 255);
    }
  }
  return {
    pixelWidth: PIXEL_SIZE,
    pixelHeight: PIXEL_SIZE,
    scale: TRAY_ICON_SCALE,
    buffer,
  };
}

function insideWrenyardMark(x: number, y: number): boolean {
  const eyeCutout = BIRDS.some((bird) => insideCircle(x, y, bird.eye));
  if (eyeCutout) return false;
  const bird = BIRDS.some((shape) => (
    insideEllipse(x, y, shape.body)
    || insideCircle(x, y, shape.head)
    || insideTriangle(x, y, shape.beak)
  ));
  if (bird) return true;

  const branchY = 28 + ((x - 18) * (x - 18)) / 125;
  const branch = x >= 2.5 && x <= 34.5 && Math.abs(y - branchY) <= 1.05;
  const leftFoot = distanceToSegment(x, y, 8.2, 24.8, 7.6, 28.5) <= 0.7;
  const middleFoot = distanceToSegment(x, y, 18.1, 25.4, 18.8, 28.1) <= 0.7;
  const rightFoot = distanceToSegment(x, y, 28.4, 25.4, 29.1, 28.8) <= 0.7;
  return branch || leftFoot || middleFoot || rightFoot;
}

function insideEllipse(
  x: number,
  y: number,
  [cx, cy, rx, ry]: BirdShape['body'],
): boolean {
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
}

function insideCircle(
  x: number,
  y: number,
  [cx, cy, radius]: BirdShape['head'],
): boolean {
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function insideTriangle(
  x: number,
  y: number,
  [x1, y1, x2, y2, x3, y3]: BirdShape['beak'],
): boolean {
  const d1 = triangleSign(x, y, x1, y1, x2, y2);
  const d2 = triangleSign(x, y, x2, y2, x3, y3);
  const d3 = triangleSign(x, y, x3, y3, x1, y1);
  return !(d1 < 0 || d2 < 0 || d3 < 0) || !(d1 > 0 || d2 > 0 || d3 > 0);
}

function triangleSign(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy));
}
