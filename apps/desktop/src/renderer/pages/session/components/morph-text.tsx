/**
 * Text that morphs from one value to the next the way the Claude app does:
 * characters shared with the previous value keep their DOM node and slide to
 * their new position, new characters fade and slide in, and removed ones fade
 * out where they were. Under reduced motion the label crossfades instead.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import { prefersReducedMotion } from '@/renderer/lib/motion';

/** How long a kept character slides to its new position. */
const MOVE_MS = 220;
/** How long an entering or a leaving character fades. */
const FADE_MS = 150;

/** One character plus the identity it keeps across text changes. */
interface Cell {
  id: number;
  char: string;
}

/** A character's offset inside the component, in pixels. */
interface Offset {
  left: number;
  top: number;
}

/** A character the new text dropped, fading out at its last position. */
interface Leaving extends Cell, Offset {}

const NO_ENTERING: ReadonlySet<number> = new Set();

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

/** Cells of a text shown for the first time: nothing enters, nothing leaves. */
function initialCells(text: string, nextId: () => number): Cell[] {
  return [...text].map((char) => ({ id: nextId(), char }));
}

/**
 * Cells of `text`, reusing the identity of an equal character left over from
 * `previous`, so a kept character keeps its node and can slide to its new
 * place. Characters with no predecessor are new.
 */
function reuseCells(
  previous: readonly Cell[],
  text: string,
  nextId: () => number,
): { cells: Cell[]; entering: Set<number> } {
  const pool = new Map<string, number[]>();
  for (const cell of previous) {
    const ids = pool.get(cell.char);
    if (ids === undefined) pool.set(cell.char, [cell.id]);
    else ids.push(cell.id);
  }
  const cells: Cell[] = [];
  const entering = new Set<number>();
  for (const char of text) {
    const reused = pool.get(char)?.shift();
    const id = reused ?? nextId();
    if (reused === undefined) entering.add(id);
    cells.push({ id, char });
  }
  return { cells, entering };
}

/** Offsets and nodes of every character currently in the flow, by identity. */
function measure(
  container: HTMLElement,
  selector: string,
): { offsets: Map<number, Offset>; nodes: Map<number, HTMLElement> } {
  const base = container.getBoundingClientRect();
  const offsets = new Map<number, Offset>();
  const nodes = new Map<number, HTMLElement>();
  for (const node of Array.from(container.querySelectorAll<HTMLElement>(selector))) {
    const id = Number(node.dataset.morphId);
    const rect = node.getBoundingClientRect();
    offsets.set(id, { left: rect.left - base.left, top: rect.top - base.top });
    nodes.set(id, node);
  }
  return { offsets, nodes };
}

/** A space is rendered unbreakable so it keeps its width inside its own box. */
function shown(char: string): string {
  return char === ' ' ? '\u00A0' : char;
}

export interface MorphTextProps {
  /** Text to show; changing it morphs the previously shown text into this one. */
  text: string;
  className?: string;
}

/** One line of text that morphs whenever its value changes. */
export function MorphText({ text, className }: MorphTextProps) {
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const idRef = useRef(0);
  const nextId = (): number => {
    idRef.current += 1;
    return idRef.current;
  };
  const [cells, setCells] = useState<Cell[]>(() => initialCells(text, nextId));
  const [entering, setEntering] = useState<ReadonlySet<number>>(NO_ENTERING);
  const [leaving, setLeaving] = useState<Leaving[]>([]);
  // The previous whole text, kept only for the reduced-motion crossfade.
  const [outgoing, setOutgoing] = useState<string | undefined>(undefined);
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const offsetsRef = useRef<Map<number, Offset>>(new Map());
  const shownRef = useRef(text);

  // Swap the characters before the browser paints the new text.
  useLayoutEffect(() => {
    if (shownRef.current === text) return;
    const previous = cellsRef.current;
    shownRef.current = text;
    if (reduced) {
      setOutgoing(previous.map((cell) => cell.char).join(''));
      return;
    }
    const container = containerRef.current;
    const last = container === null ? new Map<number, Offset>() : measure(container, '[data-morph-id]').offsets;
    const { cells: next, entering: fresh } = reuseCells(previous, text, nextId);
    const kept = new Set(next.map((cell) => cell.id));
    const gone: Leaving[] = [];
    for (const cell of previous) {
      if (kept.has(cell.id)) continue;
      const at = last.get(cell.id);
      gone.push({ ...cell, left: at?.left ?? 0, top: at?.top ?? 0 });
    }
    setCells(next);
    setEntering(fresh);
    setLeaving(gone);
  }, [text, reduced]);

  // Slide every kept character from where it was to where it is now.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const { offsets, nodes } = measure(container, '[data-morph-id]');
    const previous = offsetsRef.current;
    offsetsRef.current = offsets;
    const moved: HTMLElement[] = [];
    for (const [id, node] of nodes) {
      const from = previous.get(id);
      const to = offsets.get(id);
      if (from === undefined || to === undefined) continue;
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      node.style.transition = 'none';
      node.style.transform = `translate(${dx}px, ${dy}px)`;
      moved.push(node);
    }
    if (moved.length === 0) return;
    const frame = requestAnimationFrame(() => {
      for (const node of moved) {
        node.style.transition = `transform ${MOVE_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;
        node.style.transform = '';
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [cells]);

  // Fade the dropped characters out where they used to sit.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null || leaving.length === 0) return;
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-morph-leaving]'));
    const frame = requestAnimationFrame(() => {
      for (const node of nodes) {
        node.style.transition = `opacity ${FADE_MS}ms linear, transform ${FADE_MS}ms ease-in`;
        node.style.opacity = '0';
        node.style.transform = 'translateY(2px)';
      }
    });
    const timer = window.setTimeout(() => setLeaving([]), FADE_MS + 60);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [leaving]);

  useEffect(() => {
    if (outgoing === undefined) return;
    const timer = window.setTimeout(() => setOutgoing(undefined), FADE_MS);
    return () => window.clearTimeout(timer);
  }, [outgoing]);

  if (reduced) {
    return (
      <span className={cn('relative inline-block', className)}>
        {outgoing !== undefined && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 animate-out fade-out-0 duration-150"
            style={{ animationFillMode: 'forwards' }}
          >
            {outgoing}
          </span>
        )}
        <span key={text} className="animate-in fade-in duration-150">{text}</span>
      </span>
    );
  }

  return (
    <span ref={containerRef} className={cn('relative inline-block', className)}>
      {cells.map((cell) => (
        <span
          key={cell.id}
          data-morph-id={cell.id}
          className={cn(
            'inline-block',
            entering.has(cell.id) && 'animate-in fade-in slide-in-from-bottom-1 duration-150',
          )}
        >
          {shown(cell.char)}
        </span>
      ))}
      {leaving.map((cell) => (
        <span
          key={cell.id}
          aria-hidden
          data-morph-leaving
          className="pointer-events-none absolute inline-block"
          style={{ left: cell.left, top: cell.top }}
        >
          {shown(cell.char)}
        </span>
      ))}
    </span>
  );
}
