import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import { prefersReducedMotion } from '@/renderer/lib/motion';

/**
 * Small reusable number animation for the status-bar metrics (session metrics
 * spec). It eases from the currently displayed value to the new target over
 * about 500ms and continues smoothly across updates; `format` is applied to the
 * interpolated value so scaled usage is formatted after interpolation.
 *
 * The animated text is overlaid on an invisible sizer holding the formatted
 * endpoints of the tween, so a changing digit count never resizes the box or
 * nudges its neighbours while the value interpolates.
 *
 * Transitions to or from the em-dash placeholder never interpolate: they swap
 * text and fade it in. The first render never animates. Reduced motion is
 * tracked reactively, so turning it on silences an in-flight numeric tween and
 * fades alike.
 */
const DURATION_MS = 500;

function easeOut(progress: number): number {
  return 1 - Math.pow(1 - progress, 3);
}

/**
 * Whether motion is reduced, re-rendering when the OS preference or the
 * explicit `data-motion` switch changes, so a tween or fade can stop mid-flight.
 */
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

export interface AnimatedNumberProps {
  /** Target value; `undefined` renders the em-dash placeholder. */
  value: number | undefined;
  /** Formats the interpolated numeric value; never called for `undefined`. */
  format(value: number): string;
  className?: string;
}

export function AnimatedNumber({ value, format, className }: AnimatedNumberProps) {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState<number | undefined>(value);
  const displayRef = useRef<number | undefined>(value);
  const frameRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(false);
  // Remounts the text node only on a number/em-dash swap so its fade replays.
  const [fadeKey, setFadeKey] = useState(0);
  // Formatted endpoints of the in-flight tween; the sizer reserves their width.
  const [reserve, setReserve] = useState<string[]>(() => (value === undefined ? ['—'] : [format(value)]));

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  useEffect(() => {
    const from = displayRef.current;
    if (value === from) return;
    if (frameRef.current !== undefined) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    }

    const fromText = from === undefined ? '—' : format(from);
    const targetText = value === undefined ? '—' : format(value);
    const kindChanged = (value === undefined) !== (from === undefined);
    // Reserve both endpoints so the box width stays put for the whole tween.
    setReserve(fromText === targetText ? [targetText] : [fromText, targetText]);
    if (kindChanged && mountedRef.current && !reduced) {
      // Em-dash transitions use opacity only, never numeric interpolation.
      setFadeKey((key) => key + 1);
    }

    if (value === undefined || from === undefined || reduced) {
      displayRef.current = value;
      setDisplay(value);
      return;
    }

    const start = performance.now();
    const step = (now: number): void => {
      // Re-read the live preference so turning it on mid-tween jumps to target.
      if (prefersReducedMotion()) {
        displayRef.current = value;
        setDisplay(value);
        frameRef.current = undefined;
        return;
      }
      const progress = Math.min(1, (now - start) / DURATION_MS);
      const next = progress < 1 ? from + (value - from) * easeOut(progress) : value;
      displayRef.current = next;
      setDisplay(next);
      frameRef.current = progress < 1 ? requestAnimationFrame(step) : undefined;
    };
    frameRef.current = requestAnimationFrame(step);
    // `format` is stable for every caller; `reduced` restarts the effect so a
    // preference flip cancels the tween instead of continuing it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduced]);

  const targetText = value === undefined ? '—' : format(value);
  const currentText = display === undefined ? '—' : format(display);
  const sizerTexts = useMemo(() => {
    const texts = new Set(reserve);
    texts.add(targetText);
    return [...texts];
  }, [reserve, targetText]);

  const animated = fadeKey > 0 && !reduced;
  return (
    <span data-slot="animated-number" className={cn('relative inline-block tabular-nums', className)}>
      <span aria-hidden className="invisible grid">
        {sizerTexts.map((text) => (
          <span key={text} className="col-start-1 row-start-1">{text}</span>
        ))}
      </span>
      <span key={fadeKey} className={cn('absolute inset-0 flex items-center', animated && 'animate-in fade-in')}>
        {currentText}
      </span>
    </span>
  );
}
