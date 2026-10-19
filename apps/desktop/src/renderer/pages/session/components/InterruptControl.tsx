/**
 * The composer's stop control, shown in place of send while turns run and the
 * draft is empty. One running turn stops on click; several open a list to stop
 * one or all of them. Escape never stops directly: with one running turn a
 * second Escape within two seconds does, with several it opens the list.
 */
import { useEffect, useRef, useState } from 'react';
import { Square } from 'lucide-react';
import { Elapsed } from '@/renderer/components/elapsed';
import { InputGroupButton } from '@/renderer/components/ui/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/renderer/components/ui/popover';
import { Separator } from '@/renderer/components/ui/separator';
import { Spinner } from '@/renderer/components/ui/spinner';
import { toast } from '@/renderer/lib/notify';
import type { TurnModel } from '../model/types.js';

/** How long the first Escape stays armed. */
const ESCAPE_WINDOW_MS = 2_000;

/** An open dialog, menu or popover owns Escape; it never counts toward an interrupt. */
function overlayOpen(): boolean {
  return document.querySelector('[role="dialog"][data-open], [role="menu"][data-open], [role="listbox"][data-open], [data-slot="popover-content"][data-open]') !== null;
}

/** Editors other than the composer keep Escape for themselves. */
function foreignEditor(target: EventTarget | null, composer: HTMLTextAreaElement | null): boolean {
  if (!(target instanceof HTMLElement) || target === composer) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

function firstLine(text: string): string {
  return (text.split('\n', 1)[0] ?? '').trim();
}

export interface InterruptControlProps {
  /** The session's running turns, oldest first. */
  running: readonly TurnModel[];
  /** Interrupt one turn. */
  onInterrupt: (turn: number) => void;
  /** The composer textarea, whose Escape counts toward an interrupt. */
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
}

/** The stop button with its two-step Escape. */
export function InterruptControl({ running, onInterrupt, composerRef }: InterruptControlProps) {
  const [open, setOpen] = useState(false);
  const armedUntil = useRef(0);
  const single = running.length === 1 ? running[0] : undefined;
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (overlayOpen() || foreignEditor(event.target, composerRef.current)) return;
      const turns = runningRef.current;
      if (turns.length === 0) return;
      if (turns.length > 1) {
        setOpen(true);
        return;
      }
      const now = Date.now();
      if (now < armedUntil.current) {
        armedUntil.current = 0;
        onInterrupt(turns[0]!.id);
        return;
      }
      armedUntil.current = now + ESCAPE_WINDOW_MS;
      toast('再按 Esc 中断当前回合', { durationMs: ESCAPE_WINDOW_MS });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onInterrupt, composerRef]);

  const button = (
    <InputGroupButton
      type="button"
      variant="default"
      size="icon-sm"
      className="size-6 shrink-0 rounded-full p-0"
      aria-label="中断"
      title="中断"
      disabled={single?.interrupting === true}
      onClick={single === undefined ? undefined : () => onInterrupt(single.id)}
    >
      {single?.interrupting === true ? <Spinner /> : <Square className="size-2.5" fill="currentColor" strokeWidth={0} />}
    </InputGroupButton>
  );
  if (single !== undefined) return button;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={button} />
      <PopoverContent side="top" align="end" className="w-72 gap-1 p-1.5">
        {running.map((turn) => (
          <button
            key={turn.id}
            type="button"
            className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-60"
            disabled={turn.interrupting}
            onClick={() => onInterrupt(turn.id)}
          >
            <span className="shrink-0 text-muted-foreground">第 {turn.id} 轮</span>
            <span className="min-w-0 flex-1 truncate">{firstLine(turn.user.text)}</span>
            <Elapsed start={turn.startedAt} className="shrink-0 text-xs tabular-nums text-muted-foreground" />
            {turn.interrupting ? <Spinner className="size-3.5" /> : <Square className="size-3 shrink-0 fill-current text-muted-foreground" />}
          </button>
        ))}
        <Separator className="my-1" />
        <button
          type="button"
          className="w-full rounded-xl px-2.5 py-1.5 text-left text-sm text-destructive hover:bg-muted"
          onClick={() => {
            for (const turn of running) if (!turn.interrupting) onInterrupt(turn.id);
            setOpen(false);
          }}
        >
          全部中断
        </button>
      </PopoverContent>
    </Popover>
  );
}
