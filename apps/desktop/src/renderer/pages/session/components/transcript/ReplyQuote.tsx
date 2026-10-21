/**
 * A one-line quote of the user message a reply block answers. Shown only while
 * turns overlap, so that a block sitting below a newer user message can still
 * be read as an answer to the older one. Clicking it scrolls the quoted user
 * message into the middle of the view.
 */
import { CornerDownRight } from 'lucide-react';
import type { TurnModel } from '../../model/types.js';
import { splitReplyQuote } from '../conversation/UserMessage.js';

/** The muted, single-line quote of `turn`'s user message; scrolls to it on click. */
export function ReplyQuote({ turn }: { turn: TurnModel }) {
  const text = splitReplyQuote(turn.user.text).body.replace(/\s+/g, ' ').trim();
  return (
    <button
      type="button"
      onClick={() =>
        document.querySelector(`[data-turn-id="${turn.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      className="flex max-w-full items-center gap-1.5 border-l-2 border-border pl-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <CornerDownRight className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
    </button>
  );
}
