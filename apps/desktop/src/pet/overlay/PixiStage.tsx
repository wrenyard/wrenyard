// ── Pixi stage canvas ────────────────────────────────────────────────
// The single Pixi-owned layer of an overlay. It owns nothing but the
// transparent canvas element; the overlay component wires the render surface,
// scene and ticker to the canvas ref.

import type { RefObject } from 'react';

export const PIXI_STAGE_CLASS = 'absolute inset-0 block h-full w-full bg-transparent';

export interface PixiStageProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
}

export function PixiStage({ canvasRef }: PixiStageProps) {
  return <canvas ref={canvasRef} aria-hidden="true" className={PIXI_STAGE_CLASS} />;
}
