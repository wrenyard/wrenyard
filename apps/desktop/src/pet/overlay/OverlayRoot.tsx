// ── Pet overlay React root ───────────────────────────────────────────
// Single transparent React root shared by the house, worker and entity
// overlays. It layers the Pixi-owned sprite canvas (PixiStage) underneath the
// purely presentational DOM UI (OverlayUi), mirrors the shell appearance on
// <html>, and owns the hit/passthrough decision.
//
// Only the two root layers live here; characters/animation stay in Pixi and
// all text/cards are supplied as children using the shared renderer UI.

import {
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { OverlayUi } from './OverlayUi';
import { PixiStage } from './PixiStage';

/** Resolved Pet overlay appearance (structural mirror of the shell DTO). */
export interface PetAppearance {
  theme: string;
  dark: boolean;
  reduceMotion: boolean;
}

/**
 * Minimal appearance bridge. Pet preloads are narrow and must not import
 * `renderer/lib/theme`, so the shared `petAppearanceBridge` adapter (owned by
 * the Pet appearance wiring) plugs in here.
 */
export interface PetAppearanceBridge {
  getSnapshot(): PetAppearance;
  subscribe(listener: (next: PetAppearance) => void): () => void;
}

/** Alpha test against the Pixi canvas at CSS-pixel viewport coordinates. */
export type CanvasHitTest = (x: number, y: number) => boolean;

export interface OverlayRootProps {
  /** Live appearance source; defaults to the static light "paper" appearance. */
  appearance?: PetAppearanceBridge;
  /** Canvas owned by the overlay; created here and wired by the overlay component. */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Canvas pixel test that preserves transparent click-through. Default: never a hit. */
  isCanvasOpaqueAt?: CanvasHitTest;
  /** Reports passthrough transitions to the sender-owned preload IPC. */
  onPassthroughChange?: (passthrough: boolean) => void;
  /** DOM UI layer (cards, bubbles, labels) drawn above the sprite canvas. */
  children?: ReactNode;
}

/** Interactive DOM must opt in with `data-hit`; nothing is hit-tested implicitly. */
export const OVERLAY_HIT_ATTRIBUTE = 'data-hit';

const DEFAULT_APPEARANCE: PetAppearance = { theme: 'paper', dark: false, reduceMotion: false };

/** Fully transparent canvas: every canvas pixel stays click-through. */
const NEVER_OPAQUE: CanvasHitTest = () => false;

function applyAppearance(appearance: PetAppearance): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = appearance.theme;
  root.classList.toggle('dark', appearance.dark);
  root.dataset.motion = appearance.reduceMotion ? 'reduce' : 'system';
}

function usePetAppearance(bridge: PetAppearanceBridge | undefined): PetAppearance {
  const [appearance, setAppearance] = useState<PetAppearance>(() =>
    bridge ? bridge.getSnapshot() : DEFAULT_APPEARANCE,
  );

  useEffect(() => {
    if (!bridge) return;
    const sync = (): void => setAppearance(bridge.getSnapshot());
    sync();
    return bridge.subscribe(sync);
  }, [bridge]);

  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);

  return appearance;
}

/**
 * Passthrough decision for one pointer position:
 *  - a `[data-hit]` element under the pointer keeps the window blocking;
 *  - otherwise an opaque canvas pixel keeps the window blocking;
 *  - anything else (transparent sprite pixel / empty space) passes through.
 */
export function resolvePassthrough(
  doc: Document,
  canvas: HTMLCanvasElement | null,
  isCanvasOpaqueAt: CanvasHitTest,
  x: number,
  y: number,
): boolean {
  const target = doc.elementFromPoint(x, y);
  if (target && target.closest(`[${OVERLAY_HIT_ATTRIBUTE}]`)) return false;
  if (canvas && (target === canvas || canvas.contains(target))) {
    return !isCanvasOpaqueAt(x, y);
  }
  return true;
}

export function OverlayRoot({
  appearance,
  canvasRef,
  isCanvasOpaqueAt = NEVER_OPAQUE,
  onPassthroughChange,
  children,
}: OverlayRootProps): ReactElement {
  usePetAppearance(appearance);

  // Overlay windows must never paint an opaque document background.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const { documentElement, body } = document;
    const previousHtml = documentElement.style.background;
    const previousBody = body?.style.background;
    documentElement.style.background = 'transparent';
    if (body) body.style.background = 'transparent';
    return () => {
      documentElement.style.background = previousHtml;
      if (body) body.style.background = previousBody;
    };
  }, []);

  // Track the pointer and emit only real passthrough transitions.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let last: boolean | undefined;
    const emit = (passthrough: boolean): void => {
      if (passthrough === last) return;
      last = passthrough;
      onPassthroughChange?.(passthrough);
    };
    const onMove = (event: MouseEvent): void => {
      emit(resolvePassthrough(document, canvasRef.current, isCanvasOpaqueAt, event.clientX, event.clientY));
    };
    const onLeave = (): void => emit(true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseleave', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseleave', onLeave);
    };
  }, [canvasRef, isCanvasOpaqueAt, onPassthroughChange]);

  return (
    <div data-overlay-root className="absolute inset-0">
      <PixiStage canvasRef={canvasRef} />
      <OverlayUi>{children}</OverlayUi>
    </div>
  );
}
