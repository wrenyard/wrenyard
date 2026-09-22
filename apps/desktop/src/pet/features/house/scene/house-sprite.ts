/**
 * Live 48x40 house pixel art dispatcher.
 *
 * Exports the shared house contract constants and delegates pixel program
 * construction to skin-specific modules.
 */

import { type PixelProgram, type RenderPixel } from '../../../render';
import type { HouseSkinId } from '../../../shared/entities';
import { buildClassicPixelProgram, updateClassicHouseSprite } from './house-skin-classic';
import { buildMushroomPixelProgram, updateMushroomHouseSprite } from './house-skin-mushroom';

export const HOUSE_PX_W = 48;
export const HOUSE_PX_H = 40;

export const CRATES_MAX = 10;
export const TOKENS_PER_CRATE = 50_000_000;

export function buildHousePixelProgram(skin: HouseSkinId = 'classic'): PixelProgram {
  if (skin === 'mushroom') {
    return buildMushroomPixelProgram();
  }
  return buildClassicPixelProgram();
}

export function updateHouseSprite(
  sprite: RenderPixel,
  x: number,
  y: number,
  scale: number,
  running: boolean,
  runningWorkerCount: number,
  totalTokens: number,
  dispatchCount: number,
  skin: HouseSkinId = 'classic',
): void {
  if (skin === 'mushroom') {
    updateMushroomHouseSprite(sprite, x, y, scale, running, runningWorkerCount, totalTokens, dispatchCount);
  } else {
    updateClassicHouseSprite(sprite, x, y, scale, running, runningWorkerCount, totalTokens, dispatchCount);
  }
}
