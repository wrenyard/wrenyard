/**
 * Internal barrel for the PixiJS render subtree.
 *
 * This is the ONLY module under src/render that src/render/index.ts imports
 * from. All pixi.js imports are confined to this subtree.
 *
 * FU-001 / IU-002
 */

export { PixiRenderSurface, createPixiRenderSurface } from './surface';
export { PixiRenderContainer } from './container';
export { PixiRenderGraphics } from './graphics';
export { PixiRenderText } from './text';
export { PixiRenderPixel } from './pixel';
export { PixiRenderTicker } from './ticker';
export { PixiRenderNode } from './node';
