/**
 * Public render barrel (domain-free fixed API).
 *
 * Re-exports the fixed type/interface declarations from types.ts, the
 * PixelBuilder from pixel-builder.ts, and the createRenderSurface factory from
 * the Pixi adapter. No PixiJS types are surfaced, and no pet-domain module is
 * imported.
 *
 * Text is no longer part of this layer: every Pet text/card surface is React
 * DOM, so the surface only builds sprites, graphics and pixel programs.
 */

// Fixed public types only (no implementation details).
export type {
  RenderSurfaceOptions,
  RenderViewport,
  FrameCallback,
  RenderNode,
  RenderContainer,
  RenderGraphics,
  RenderColor,
  RenderPoint,
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

// Domain-free builder plus the program pixel test used by Pet hit testing.
export { PixelBuilder, pixelProgramCoversPoint } from './pixel-builder';
