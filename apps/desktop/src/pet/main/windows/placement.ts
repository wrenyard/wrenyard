// ── TaskGraph window placement ───────────────────────────────────────
// Pure geometry for the Blueprint Wren entity window and the Graph Slip
// window. No Electron or owner state is involved, so the owner and the
// window factories share one source of window bounds.

// K3 Blueprint Wren: 28x22 authored grid at 3x = 84x66 display pixels,
// hosted inside a transparent entity window. The fact slip is the shared
// `Card` (size=sm) at `text-xs`, so the carrier is tall enough to hold it
// above or below the bird without clipping.
export const ENTITY_WINDOW_WIDTH = 156;
export const WREN_DISPLAY_WIDTH = 84;
export const WREN_DISPLAY_HEIGHT = 66;
/** Rendered height of the shared Card(size=sm) fact slip at text-xs. */
export const ENTITY_SLIP_HEIGHT = 48;
/** Breathing room between the bird and its fact slip. */
export const ENTITY_SLIP_GAP = 6;
export const ENTITY_WINDOW_HEIGHT = WREN_DISPLAY_HEIGHT + ENTITY_SLIP_GAP + ENTITY_SLIP_HEIGHT;

export const GRAPH_SLIP_MIN_WIDTH = 380;
export const GRAPH_SLIP_MIN_HEIGHT = 280;
export const GRAPH_SLIP_HEADER_HEIGHT = 24;
export const GRAPH_SLIP_SCREEN_MARGIN = 32;

export interface WrenWindowPlacement {
  windowBounds: { x: number; y: number; width: number; height: number };
  birdOffsetX: number;
  birdOffsetY: number;
  tipSide: 'above' | 'below';
}

export function placeWrenWindow(
  desiredBird: { x: number; y: number },
  workArea: { x: number; y: number; width: number; height: number },
): WrenWindowPlacement {
  const maxBirdX = workArea.x + workArea.width - WREN_DISPLAY_WIDTH;
  const maxBirdY = workArea.y + workArea.height - WREN_DISPLAY_HEIGHT;
  const birdX = Math.round(Math.max(workArea.x, Math.min(desiredBird.x, maxBirdX)));
  const birdY = Math.round(Math.max(workArea.y, Math.min(desiredBird.y, maxBirdY)));

  // Keep the tooltip-bearing transparent window on-screen, but slide the
  // visible bird inside it. Near the right edge the bird moves to the right
  // side of the window, leaving the fact slip extending left instead of
  // blocking further movement. Near the bottom the slip flips above.
  const maxWindowX = workArea.x + workArea.width - ENTITY_WINDOW_WIDTH;
  const windowX = Math.round(Math.max(workArea.x, Math.min(birdX, maxWindowX)));
  const tipSide = birdY + ENTITY_WINDOW_HEIGHT <= workArea.y + workArea.height
    ? 'below'
    : 'above';
  const windowY = tipSide === 'below'
    ? birdY
    : birdY - (ENTITY_WINDOW_HEIGHT - WREN_DISPLAY_HEIGHT);

  return {
    windowBounds: {
      x: windowX,
      y: Math.round(windowY),
      width: ENTITY_WINDOW_WIDTH,
      height: ENTITY_WINDOW_HEIGHT,
    },
    birdOffsetX: birdX - windowX,
    birdOffsetY: tipSide === 'below' ? 0 : ENTITY_WINDOW_HEIGHT - WREN_DISPLAY_HEIGHT,
    tipSide,
  };
}

export interface SizeArea {
  width: number;
  height: number;
}

export function fitGraphSlipWindowSize(
  content: SizeArea,
  workArea: SizeArea,
  saved?: { width?: number; height?: number },
): { width: number; height: number } {
  const maxWidth = Math.max(GRAPH_SLIP_MIN_WIDTH, Math.floor(workArea.width - GRAPH_SLIP_SCREEN_MARGIN));
  const maxHeight = Math.max(GRAPH_SLIP_MIN_HEIGHT, Math.floor(workArea.height - GRAPH_SLIP_SCREEN_MARGIN));
  const hasSavedSize = typeof saved?.width === 'number' && Number.isFinite(saved.width)
    && typeof saved?.height === 'number' && Number.isFinite(saved.height);
  const requestedWidth = hasSavedSize ? saved.width! : Math.ceil(content.width);
  const requestedHeight = hasSavedSize ? saved.height! : Math.ceil(content.height + GRAPH_SLIP_HEADER_HEIGHT);
  return {
    width: Math.min(maxWidth, Math.max(GRAPH_SLIP_MIN_WIDTH, requestedWidth)),
    height: Math.min(maxHeight, Math.max(GRAPH_SLIP_MIN_HEIGHT, requestedHeight)),
  };
}
