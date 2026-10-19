/**
 * The live line's glyph: one character that keeps changing shape so the line
 * reads as working, at a fixed width of one character so the label beside it
 * never shifts. Reduced motion gets a static glyph with a slow opacity pulse.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import { prefersReducedMotion } from '@/renderer/lib/motion';

/** The shapes the glyph cycles through, in order. */
const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽'];
/** How long one shape stays on screen. */
const FRAME_MS = 120;
/** The shape shown when nothing animates. */
const STATIC_GLYPH = '✻';
/** Keyframes of the reduced-motion pulse; the shared pulse utility is disabled there. */
const PULSE = 'live-glyph-pulse';

let pulseRegistered = false;

/** Whether motion is reduced, re-rendering when the preference flips. */
function useReducedMotion(): boolean {
  const subscribe = useMemo(
    () => (onChange: () => void): (() => void) => {
      const query = window.matchMedia('(prefers-reduced-motion: reduce)');
      query.addEventListener('change', onChange);
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
      return () => {
        query.removeEventListener('change', onChange);
        observer.disconnect();
      };
    },
    [],
  );
  return useSyncExternalStore(subscribe, prefersReducedMotion, prefersReducedMotion);
}

/**
 * Register the pulse keyframes once. The app's own pulse animation is switched
 * off under reduced motion, so this component carries its own.
 */
function usePulseKeyframes(): void {
  useEffect(() => {
    if (pulseRegistered) return;
    pulseRegistered = true;
    const style = document.createElement('style');
    style.textContent = `@keyframes ${PULSE} { 0%, 100% { opacity: 1 } 50% { opacity: 0.35 } }`;
    document.head.append(style);
  }, []);
}

export interface LiveGlyphProps {
  className?: string;
}

/** The animated one-character glyph of a running step. */
export function LiveGlyph({ className }: LiveGlyphProps) {
  const reduced = useReducedMotion();
  usePulseKeyframes();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const timer = window.setInterval(() => {
      setFrame((value) => (value + 1) % GLYPHS.length);
    }, FRAME_MS);
    return () => window.clearInterval(timer);
  }, [reduced]);

  return (
    <span
      aria-hidden
      className={cn('inline-block w-[1ch] shrink-0 text-primary', className)}
      style={reduced ? { animation: `${PULSE} 2s ease-in-out infinite` } : undefined}
    >
      {reduced ? STATIC_GLYPH : GLYPHS[frame]}
    </span>
  );
}
