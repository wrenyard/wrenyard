import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { ArrowUp } from 'lucide-react';
import {
  InputGroup,
  InputGroupButton,
  InputGroupTextarea,
} from '@/renderer/components/ui/input-group';

export type PromptSendKey = 'enter' | 'mod-enter';

export interface PromptInputProps {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  submitDisabled?: boolean;
  /** Which key submits: plain Enter, or Cmd/Ctrl+Enter. */
  sendKey?: PromptSendKey;
  toolbar?: ReactNode;
  /** Rendered at the leading edge, just before the textarea. */
  toolbarLeading?: ReactNode;
  /** Rendered at the trailing edge, just before the send button. */
  toolbarTrailing?: ReactNode;
  /** Rendered above the textarea; the composer puts attachment previews here. */
  attachments?: ReactNode;
  /** When true, an empty textarea may still submit (attachment-only message). */
  hasAttachments?: boolean;
  /** Optional paste hook; the composer stages pasted clipboard images. */
  onPaste?: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  className?: string;
  /**
   * Ghost next-input suggestion. While the value is empty it reads as the
   * field's muted placeholder; Tab accepts it into the draft and Escape
   * dismisses it. Navigation and modifier keys leave it in place, and typing
   * (handled by the composer) clears it. No suggestion leaves every existing key
   * behaviour untouched.
   */
  suggestion?: string;
  /** Accept the shown suggestion into the draft (never submits). */
  onAcceptSuggestion?: () => void;
  /** Dismiss the shown suggestion and cancel its in-flight request. */
  onDismissSuggestion?: () => void;
}

/**
 * Auto-growing composed input. The submit key follows `sendKey`: plain `Enter`
 * or `Cmd/Ctrl+Enter`. `Shift+Enter` always inserts a newline, and an active IME
 * composition never submits. The send button submits as well; interrupting
 * a turn happens on that turn's message. `submitDisabled` blocks the keyboard
 * submit path and the button while keeping the textarea editable.
 */
export function PromptInput({
  value,
  onValueChange,
  onSubmit,
  placeholder,
  disabled = false,
  submitDisabled = false,
  sendKey = 'enter',
  toolbar,
  toolbarLeading,
  toolbarTrailing,
  attachments,
  hasAttachments = false,
  onPaste,
  textareaRef,
  className,
  suggestion,
  onAcceptSuggestion,
  onDismissSuggestion,
}: PromptInputProps) {
  const composing = useRef(false);
  // The caller may own the textarea ref (the composer focuses it); otherwise the
  // expansion measurement keeps a local one.
  const innerRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? innerRef;
  // Set once the measured content no longer fits the compact row; see `expanded`.
  const [overflow, setOverflow] = useState(false);
  const canSubmit = !disabled && !submitDisabled && (value.trim() !== '' || hasAttachments);
  const hasLeading = toolbarLeading !== undefined && toolbarLeading !== null;
  const hasStrip = attachments !== undefined && attachments !== null;
  // The suggestion reads as the field's placeholder while the value is empty: it
  // is muted, never part of the value, and a "Tab 补全" hint names the accept key.
  // A retained suggestion stays visible through a transient loading/disabled
  // state so the field neither hides it nor collapses its height.
  const ghost = value === '' && suggestion !== undefined ? suggestion : '';
  const placeholderText = ghost === '' ? placeholder : `${ghost}\u2003Tab 补全`;
  // The content that drives the layout: the real draft when present, otherwise
  // the shown ghost placeholder (the accept hint included; the ordinary
  // placeholder is excluded). A newline expands at once; a wrapped ghost is
  // caught before paint by the measurement below.
  const measured = value !== '' ? value : ghost === '' ? '' : placeholderText ?? '';
  // EXPANDED once the measured content carries a strip (attachments/reply/error),
  // an explicit newline, or a line that no longer fits the compact row. Expansion
  // is sticky for the same content and holds until that content is emptied.
  const expanded = hasStrip || (measured !== '' && (overflow || measured.includes('\n')));
  // A changed suggestion is re-measured from scratch so a stale expansion never
  // sticks to a new one; the same content keeps its expansion (as do typed
  // drafts). Resetting during render re-measures before the next paint.
  const [measuredGhost, setMeasuredGhost] = useState(ghost);
  if (measuredGhost !== ghost) {
    setMeasuredGhost(ghost);
    setOverflow(false);
  }
  // A shown ghost sizes to whole 22px lines plus the 1rem vertical padding,
  // bounded by main's 200px cap and by the viewport minus room for the composer
  // toolbar and window chrome, then scrolls rather than clipping; `max(22px, …)`
  // keeps at least one whole line.
  const ghostMaxHeight = 'calc(1rem + max(22px, round(down, calc(min(200px, 100svh - 8rem) - 1rem), 22px)))';

  const submit = (): void => {
    if (canSubmit) onSubmit();
  };

  const isSubmitKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.key !== 'Enter' || event.shiftKey) return false;
    const modifier = event.metaKey || event.ctrlKey;
    return sendKey === 'mod-enter' ? modifier : !modifier;
  };

  // A drawn line taller than the compact box by more than 4px means the measured
  // content no longer fits one row. The 4px tolerance absorbs fractional-DPI
  // rounding (Windows 125%/150%); one wrapped line adds a whole 24px line.
  useLayoutEffect(() => {
    if (measured === '') {
      setOverflow(false);
      return;
    }
    if (expanded) return;
    const el = ref.current;
    if (el === null) return;
    if (el.scrollHeight - el.clientHeight > 4) setOverflow(true);
  }, [measured, expanded]);

  // While the compact row still holds the content, a narrowing window can push
  // it past one line; watch the textarea's box so it expands without a keystroke.
  const watchCompactWidth = !expanded && measured !== '';
  useEffect(() => {
    if (!watchCompactWidth) return;
    const el = ref.current;
    if (el === null) return;
    const observer = new ResizeObserver(() => {
      if (el.scrollHeight - el.clientHeight > 4) setOverflow(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [watchCompactWidth]);

  // Shared container overrides win over the InputGroup defaults through its own
  // cn merge; the field's focus ring is replaced by a border tint.
  const containerBase = 'h-auto border-border bg-background shadow-none has-[[data-slot=input-group-control]:focus-visible]:ring-0 has-[[data-slot=input-group-control]:focus-visible]:border-foreground/20';
  const compactLayout = 'flex-row flex-nowrap items-center gap-1 rounded-full p-2';
  const expandedLayout = 'flex-col items-stretch gap-0 rounded-[18px] p-0';
  const compactTextareaClass = 'min-w-0 flex-1 h-6 min-h-6 py-0 pl-1 pr-0 leading-6 field-sizing-fixed overflow-hidden';
  const expandedTextareaClass = 'w-full min-w-0 px-3 py-2 leading-[22px] min-h-9 max-h-[200px] field-sizing-content overflow-y-auto';
  // A shown ghost in the expanded layout wraps long unbroken tokens
  // (`break-words`) and scrolls at the whole-line cap above instead of clipping.
  const ghostExpandedTextareaClass = 'w-full min-w-0 px-3 py-2 leading-[22px] min-h-9 field-sizing-content overflow-y-auto break-words';
  // Shared by both layouts; only one branch renders at a time.
  const sendButton = (
    <InputGroupButton type="submit" variant="default" size="icon-sm" className="size-6 shrink-0 rounded-full p-0 [&_svg]:size-3.5" disabled={!canSubmit} aria-label="发送" title="发送">
      <ArrowUp />
    </InputGroupButton>
  );

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {/* One mounted textarea, two layouts: COMPACT keeps the leading control,
          the text, the toolbar and the send button on a single pill row while
          the draft is empty or short; EXPANDED lifts the text onto its own top
          row and moves the leading control down beside the toolbar, with the
          status spans and send on the right. `expanded` alone picks the layout. */}
      <InputGroup className={`${containerBase} ${expanded ? expandedLayout : compactLayout}`}>
        {hasStrip && (
          <div className="w-full min-w-0 px-3 pt-2">{attachments}</div>
        )}
        {!expanded && hasLeading && toolbarLeading}
        {/* The textarea keeps its slot in the children list across both layouts,
            so focus, caret and IME composition survive the switch. */}
        <InputGroupTextarea
          ref={ref}
          value={value}
          placeholder={placeholderText}
          disabled={disabled}
          rows={1}
          className={`${expanded ? (ghost !== '' ? ghostExpandedTextareaClass : expandedTextareaClass) : compactTextareaClass} [[data-mini]_&]:text-sm`}
          style={expanded && ghost !== '' ? { maxHeight: ghostMaxHeight } : undefined}
          onChange={(event) => onValueChange(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            const inComposition = composing.current || event.nativeEvent.isComposing;
            if (isSubmitKey(event) && !inComposition) {
              event.preventDefault();
              submit();
              return;
            }
            // A bare Tab accepts the suggestion into the draft and never submits.
            if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
              && !inComposition && ghost !== '') {
              event.preventDefault();
              onAcceptSuggestion?.();
              return;
            }
            if (event.key === 'Escape') {
              if (value === '') onDismissSuggestion?.();
              return;
            }
          }}
          onCompositionStart={() => { composing.current = true; onDismissSuggestion?.(); }}
          onCompositionEnd={() => { composing.current = false; }}
        />
        {!expanded && (
          <div className="flex shrink-0 items-center gap-1">
            {toolbar}
            {toolbarTrailing}
            {sendButton}
          </div>
        )}
        {expanded && (
          <div className="flex w-full min-w-0 items-center justify-between gap-2 p-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              {toolbarLeading}
              {toolbar}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {toolbarTrailing}
              {sendButton}
            </div>
          </div>
        )}
      </InputGroup>
    </form>
  );
}
