// ── Worker bubble typewriter ─────────────────────────────────────────
// Browser-native text wrapping (React DOM) replaces the hand-drawn Pixi text
// layer; only the reveal cadence and the fade window remain here.
//
// Pure helpers are exported for focused tests; the hook drives React.

import { useEffect, useState } from 'react';

export const BUBBLE_FADE_MS = 800;
export const BUBBLE_REVEAL_CPS = 40;

/**
 * Bubble alpha: 0 once the remaining lifetime is gone, 1 while at least
 * {@link BUBBLE_FADE_MS} remain, otherwise a linear ramp over the tail.
 */
export function bubbleAlpha(untilMs: number, nowMs: number): number {
  const remaining = untilMs - nowMs;
  if (remaining <= 0) return 0;
  if (remaining >= BUBBLE_FADE_MS) return 1;
  return remaining / BUBBLE_FADE_MS;
}

/** Number of code points revealed at 40 cps since `startMs`. */
export function revealCharCount(text: string, startMs: number, nowMs: number): number {
  const elapsedMs = Math.max(0, nowMs - startMs);
  const revealed = Math.floor((elapsedMs / 1000) * BUBBLE_REVEAL_CPS);
  return Math.min(Array.from(text).length, revealed);
}

export interface TypewriterInput {
  text: string;
  /** Epoch ms at which the current bubble text began revealing. */
  startMs: number;
  /** Epoch ms at which the bubble disappears. */
  untilMs: number;
  reduceMotion?: boolean;
}

export interface TypewriterOutput {
  /** Currently visible prefix of the bubble text. */
  text: string;
  /** Bubble opacity in `[0, 1]`. */
  alpha: number;
}

/**
 * Reveal `text` character by character and fade it out over the final
 * {@link BUBBLE_FADE_MS}. Reduced motion reveals instantly. The internal rAF
 * loop stops once the bubble lifetime ends.
 */
export function useTypewriter({
  text,
  startMs,
  untilMs,
  reduceMotion = false,
}: TypewriterInput): TypewriterOutput {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (reduceMotion || !text) return;
    let raf = 0;
    const tick = (): void => {
      const current = Date.now();
      setNow(current);
      if (untilMs > 0 && current >= untilMs + 50) return;
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [text, startMs, untilMs, reduceMotion]);

  const alpha = bubbleAlpha(untilMs, now);
  if (reduceMotion) {
    return { text, alpha };
  }
  const count = revealCharCount(text, startMs, now);
  return { text: Array.from(text).slice(0, count).join(''), alpha };
}
