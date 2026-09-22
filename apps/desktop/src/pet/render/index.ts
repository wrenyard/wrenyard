/**
 * Public render barrel (domain-free fixed API).
 *
 * Re-exports all fixed type/interface declarations from types.ts, the
 * PixelBuilder from pixel-builder.ts, and the createRenderSurface factory from
 * the Pixi adapter. No PixiJS types are surfaced, and no pet-domain module is
 * imported.
 *
 * FU-001 / IU-002
 */

// Fixed public types only (no implementation details).
export type {
  RenderSurfaceOptions,
  RenderViewport,
  FrameCallback,
  RenderNode,
  RenderContainer,
  RenderGraphics,
  RenderText,
  RenderColor,
  RenderPoint,
  RenderTextStyle,
  ShapeCommand,
  PixelRect,
  PixelProgram,
  RenderPixel,
  RenderTicker,
  RenderSurface,
  RenderScene,
} from './types';

// Re-export the createRenderSurface factory from the Pixi adapter under the
// fixed public name. Consumers call createRenderSurface(canvas, options).
export { createPixiRenderSurface as createRenderSurface } from './pixi/surface';

// Domain-free builder.
export { PixelBuilder } from './pixel-builder';
