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
  /** Replaces the send button, for example with a stop control while turns run. */
  submitControl?: ReactNode;
  /** Rendered above the textarea; the composer puts attachment previews here. */
  attachments?: ReactNode;
  /** When true, an empty textarea may still submit (attachment-only message). */
  hasAttachments?: boolean;
  /** Optional paste hook; the composer stages pasted clipboard images. */
  onPaste?: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  className?: string;
  /**
   * Inline completion. While the draft is a prefix of it and the caret sits at
   * the end, its remaining text shows as muted ghost text after the caret; Tab,
   * or → at the end, accepts it and Escape dismisses it. A diverging draft or a
   * caret moved away dismisses it. No suggestion leaves every key untouched.
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
 * composition never submits. The send button submits as well; a caller may
 * replace it through `submitControl`. `submitDisabled` blocks the keyboard
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
  submitControl,
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
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [caretAtEnd, setCaretAtEnd] = useState(true);
  // The part of the suggestion still to type: shown only while the draft is a
  // prefix of it (a trailing space difference ignored) and the caret is at the end.
  const continuation = suggestion === undefined ? undefined : completionSuffix(value, suggestion);
  const ghost = continuation !== undefined && caretAtEnd ? continuation : '';
  // The content that drives the layout: the draft plus the shown ghost text.
  const measured = value + ghost;
  // EXPANDED once the measured content carries a strip (attachments/reply/error),
  // an explicit newline, or a line that no longer fits the compact row. Expansion
  // is sticky for the same content and holds until that content is emptied.
  const expanded = hasStrip || (measured !== '' && (overflow || measured.includes('\n')));
  // A changed suggestion is re-measured from scratch so a stale expansion never
  // sticks to a new one. Resetting during render re-measures before the next paint.
  const [measuredSuggestion, setMeasuredSuggestion] = useState(suggestion);
  if (measuredSuggestion !== suggestion) {
    setMeasuredSuggestion(suggestion);
    setOverflow(false);
  }
  // The ghost text is drawn by a mirror behind the textarea; the textarea grows
  // to the mirror's height so a wrapped suggestion is never clipped.
  const [ghostHeight, setGhostHeight] = useState(0);

  // A draft that left the suggestion, or a caret moved away from the end, drops it.
  useEffect(() => {
    if (suggestion === undefined || value === '') return;
    if (continuation === undefined || !caretAtEnd) onDismissSuggestion?.();
  }, [suggestion, value, continuation, caretAtEnd]);

  const trackCaret = (): void => {
    const el = ref.current;
    if (el === null) return;
    setCaretAtEnd(el.selectionStart === el.value.length && el.selectionEnd === el.value.length);
  };

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
    const mirror = mirrorRef.current;
    setGhostHeight(ghost === '' || mirror === null ? 0 : mirror.scrollHeight);
    if (measured === '') {
      setOverflow(false);
      return;
    }
    if (expanded) return;
    const el = ref.current;
    if (el === null) return;
    if (Math.max(el.scrollHeight, mirror?.scrollHeight ?? 0) - el.clientHeight > 4) setOverflow(true);
  }, [measured, expanded, ghost]);

  // While the compact row still holds the content, a narrowing window can push
  // it past one line; watch the textarea's box so it expands without a keystroke.
  const watchCompactWidth = !expanded && measured !== '';
  useEffect(() => {
    if (!watchCompactWidth) return;
    const el = ref.current;
    if (el === null) return;
    const observer = new ResizeObserver(() => {
      if (Math.max(el.scrollHeight, mirrorRef.current?.scrollHeight ?? 0) - el.clientHeight > 4) setOverflow(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [watchCompactWidth]);

  // Shared container overrides win over the InputGroup defaults through its own
  // cn merge; the field's focus ring is replaced by a border tint.
  const containerBase = 'h-auto border-border bg-background shadow-none has-[[data-slot=input-group-control]:focus-visible]:ring-0 has-[[data-slot=input-group-control]:focus-visible]:border-foreground/20';
  const compactLayout = 'flex-row flex-nowrap items-center gap-1 rounded-full p-2';
  const expandedLayout = 'flex-col items-stretch gap-0 rounded-[18px] p-0';
  // Padding, line height and font are shared by the textarea and its ghost mirror.
  const compactText = 'py-0 pl-1 pr-0 leading-6';
  const expandedText = 'px-3 py-2 leading-[22px]';
  const fieldText = `${expanded ? expandedText : compactText} border border-transparent text-base break-words md:text-sm [[data-mini]_&]:text-sm`;
  const compactTextareaClass = 'h-6 min-h-6 field-sizing-fixed overflow-hidden';
  const expandedTextareaClass = 'min-h-9 max-h-[200px] field-sizing-content overflow-y-auto';
  // Shared by both layouts; only one branch renders at a time.
  const sendButton = submitControl ?? (
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
        <div className={expanded ? 'relative w-full min-w-0' : 'relative min-w-0 flex-1'}>
          {ghost !== '' && (
            <div
              ref={mirrorRef}
              aria-hidden
              className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap ${fieldText}`}
            >
              <span className="invisible">{value}</span>
              <span className="text-muted-foreground">{ghost}</span>
            </div>
          )}
          <InputGroupTextarea
            ref={ref}
            value={value}
            placeholder={ghost === '' ? placeholder : undefined}
            disabled={disabled}
            rows={1}
            className={`relative w-full ${fieldText} ${expanded ? expandedTextareaClass : compactTextareaClass}`}
            style={expanded && ghostHeight > 0 ? { minHeight: Math.min(ghostHeight, 200) } : undefined}
            onChange={(event) => { onValueChange(event.target.value); trackCaret(); }}
            onSelect={trackCaret}
            onScroll={(event) => { if (mirrorRef.current !== null) mirrorRef.current.scrollTop = event.currentTarget.scrollTop; }}
            onPaste={onPaste}
            onKeyDown={(event) => {
              const inComposition = composing.current || event.nativeEvent.isComposing;
              if (isSubmitKey(event) && !inComposition) {
                event.preventDefault();
                submit();
                return;
              }
              const bare = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
              // Tab, or → with the caret at the end, accepts the completion; never submits.
              if (bare && ghost !== '' && !inComposition && (event.key === 'Tab' || event.key === 'ArrowRight')) {
                event.preventDefault();
                onAcceptSuggestion?.();
                return;
              }
              if (event.key === 'Escape' && ghost !== '') {
                // Handled here, so Escape does not also count toward interrupting a turn.
                event.preventDefault();
                onDismissSuggestion?.();
              }
            }}
            onCompositionStart={() => { composing.current = true; onDismissSuggestion?.(); }}
            onCompositionEnd={() => { composing.current = false; }}
          />
        </div>
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

/**
 * The rest of `suggestion` after `draft`, or undefined when the draft is not a
 * prefix of it. A trailing space typed before the suggestion's next word still
 * counts as a prefix. Compared case-sensitively.
 */
function completionSuffix(draft: string, suggestion: string): string | undefined {
  if (suggestion.startsWith(draft)) return suggestion.slice(draft.length);
  const trimmed = draft.trimEnd();
  if (trimmed !== draft && suggestion.startsWith(trimmed)) return suggestion.slice(trimmed.length).trimStart();
  return undefined;
}
