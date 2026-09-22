/**
 * CLI client badge rendering using PixelBuilder primitives.
 *
 * The badge is drawn at local coordinates (0,0) within its own program; the
 * caller positions the node at the badge world position (worker logical x+29,
 * y+2). Alpha moves to the PixelBuilder rect() call and the caller's setAlpha.
 * `unknown` is a no-op.
 *
 * FU-002 / IU-001
 */

import type { PixelBuilder } from '../../../render';
import type { WorkerClient } from '../../../shared/snapshot';

const BADGE_ALPHA = 0.9;
const BADGE_W = 10;
const BADGE_H = 10;

function paint(
  b: PixelBuilder,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  alpha: number,
): void {
  b.rect(x, y, w, h, color, alpha);
}

/**
 * Draw the CLI client badge at local (0,0) inside a 10x10 pixel footprint.
 * Returns the badge bounds for ROI checks. No-op for `unknown`.
 */
export function drawClientBadge(
  b: PixelBuilder,
  client: WorkerClient,
  alpha: number = BADGE_ALPHA,
): { w: number; h: number } {
  const a = Math.max(0, Math.min(1, alpha));

  if (client === 'unknown') {
    return { w: 0, h: 0 };
  }

  if (client === 'claude') {
    paint(b, 3, 0, 4, 2, '#D97757', a);
    paint(b, 3, 8, 4, 2, '#D97757', a);
    paint(b, 0, 3, 2, 4, '#D97757', a);
    paint(b, 8, 3, 2, 4, '#D97757', a);
    paint(b, 2, 2, 2, 2, '#E8A17F', a);
    paint(b, 6, 2, 2, 2, '#E8A17F', a);
    paint(b, 2, 6, 2, 2, '#E8A17F', a);
    paint(b, 6, 6, 2, 2, '#E8A17F', a);
    paint(b, 4, 4, 2, 2, '#7A3B24', a);
  } else if (client === 'codebuddy') {
    paint(b, 4, 0, 2, 1, '#0E7490', a);
    paint(b, 5, 1, 1, 2, '#0E7490', a);
    paint(b, 1, 3, 8, 6, '#0E7490', a);
    paint(b, 2, 4, 6, 4, '#67E8F9', a);
    paint(b, 3, 5, 1, 1, '#083344', a);
    paint(b, 6, 5, 1, 1, '#083344', a);
    paint(b, 4, 7, 2, 1, '#0891B2', a);
  } else if (client === 'codex') {
    paint(b, 1, 1, 8, 8, '#F5F5F0', a);
    paint(b, 1, 1, 8, 1, '#1A1A1A', a);
    paint(b, 1, 8, 8, 1, '#1A1A1A', a);
    paint(b, 1, 2, 1, 6, '#1A1A1A', a);
    paint(b, 8, 2, 1, 6, '#1A1A1A', a);
    paint(b, 4, 2, 2, 2, '#1A1A1A', a);
    paint(b, 2, 4, 2, 2, '#1A1A1A', a);
    paint(b, 6, 4, 2, 2, '#1A1A1A', a);
    paint(b, 3, 6, 2, 2, '#1A1A1A', a);
    paint(b, 5, 6, 2, 2, '#1A1A1A', a);
    paint(b, 4, 7, 2, 1, '#1A1A1A', a);
    paint(b, 4, 4, 2, 2, '#F5F5F0', a);
  }

  return { w: BADGE_W, h: BADGE_H };
}
