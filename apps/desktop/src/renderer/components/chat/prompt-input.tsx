import {
  useCallback,
  useEffect,
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
  InputGroupAddon,
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
   * Mini/compact layout (opt-in): an auto-growing input with the send
   * button inline at the trailing edge instead of a bottom toolbar row.
   */
  compact?: boolean;
  /**
   * Optional node rendered at the inline-start edge inside the rounded bar,
   * before the textarea (e.g. the compact attachment button). Nothing renders
   * when it is `undefined`.
   */
  leading?: ReactNode;
}

/**
 * Auto-growing composed input. The submit key follows `sendKey`: plain `Enter`
 * or `Cmd/Ctrl+Enter`. `Shift+Enter` always inserts a newline, and an active IME
 * composition never submits. The send button submits in both modes; interrupting
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
  toolbarTrailing,
  attachments,
  hasAttachments = false,
  onPaste,
  textareaRef,
  className,
  compact = false,
  leading,
}: PromptInputProps) {
  const composing = useRef(false);
  // Compact layout hysteresis: the single-line bar grows into the wrapped layout
  // as soon as the text needs a second line, and stays expanded until the field
  // is cleared again, so it never flickers between the two layouts.
  const [compactExpanded, setCompactExpanded] = useState(false);
  const compactTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canSubmit = !disabled && !submitDisabled && (value.trim() !== '' || hasAttachments);

  // Keep the caller's textarea ref working while also tracking the node locally
  // so the compact layout can measure whether the text needs a second line.
  const setTextareaNode = useCallback(
    (node: HTMLTextAreaElement | null) => {
      compactTextareaRef.current = node;
      if (textareaRef !== undefined) textareaRef.current = node;
    },
    [textareaRef],
  );

  useEffect(() => {
    if (compact && value === '') setCompactExpanded(false);
  }, [compact, value]);

  useEffect(() => {
    if (!compact || compactExpanded) return;
    const node = compactTextareaRef.current;
    if (node === null) return;
    if (value.includes('\n') || node.scrollHeight > node.clientHeight + 1) setCompactExpanded(true);
  }, [compact, compactExpanded, value]);

  const submit = (): void => {
    if (canSubmit) onSubmit();
  };

  const isSubmitKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.key !== 'Enter' || event.shiftKey) return false;
    const modifier = event.metaKey || event.ctrlKey;
    return sendKey === 'mod-enter' ? modifier : !modifier;
  };

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {compact && attachments !== undefined && attachments !== null && (
        <div className="mb-1 w-full px-1">{attachments}</div>
      )}
      <InputGroup
        className={
          compact
            ? compactExpanded
              ? 'rounded-2xl'
              : leading === undefined
                ? 'rounded-full pl-1'
                : 'rounded-full'
            : undefined
        }
      >
        {!compact && attachments !== undefined && attachments !== null && (
          <div className="w-full px-2.5 pt-2">{attachments}</div>
        )}
        {/* The compact card stays below the `md` breakpoint, so typed text keeps
            the primitive's 16px and the normal `leading-6`. The placeholder is
            1px smaller and uses an arbitrary size (no line-height override) so it
            keeps `leading-6` and stays aligned with typed text. Collapsed keeps a
            fixed one-line height; expanded grows with `field-sizing-content` and
            scrolls once it reaches `max-h-36` (about six lines). */}
        <InputGroupTextarea
          ref={setTextareaNode}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className={
            compact
              ? `min-h-8 min-w-0 py-1 leading-6 placeholder:text-[15px] ${
                  compactExpanded
                    ? 'field-sizing-content max-h-36 overflow-y-auto'
                    : 'field-sizing-fixed overflow-hidden'
                }`
              : 'max-h-60'
          }
          onChange={(event) => onValueChange(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (isSubmitKey(event) && !composing.current && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
        />
        {compact ? (
          compactExpanded ? (
            /* Wrapped layout: the textarea owns the row and the leading `+` and
               the send button move to their own row below (Cursor-style). */
            <InputGroupAddon align="block-end" className="gap-1 pb-1.5 pt-0.5">
              {leading}
              <div className="ml-auto flex items-center gap-1">
                {toolbar}
                {toolbarTrailing}
                <InputGroupButton type="submit" variant="default" size="icon-xs" disabled={!canSubmit} aria-label="发送" title="发送">
                  <ArrowUp />
                </InputGroupButton>
              </div>
            </InputGroupAddon>
          ) : (
            <>
              {/* `order-first` places the `+` ahead of the textarea visually
                  while the textarea stays the first DOM child, so switching
                  layouts never remounts it or drops focus. */}
              {leading !== undefined && (
                <InputGroupAddon align="inline-start" className="h-8 py-0">
                  {leading}
                </InputGroupAddon>
              )}
              <InputGroupAddon align="inline-end" className="h-8 gap-1 py-0">
                {toolbar}
                {toolbarTrailing}
                <InputGroupButton type="submit" variant="default" size="icon-xs" disabled={!canSubmit} aria-label="发送" title="发送">
                  <ArrowUp />
                </InputGroupButton>
              </InputGroupAddon>
            </>
          )
        ) : (
          <InputGroupAddon align="block-end">
            <div className="flex min-w-0 items-center gap-1.5">{toolbar}</div>
            <div className="ml-auto flex items-center gap-1.5">
              {toolbarTrailing}
              <InputGroupButton type="submit" variant="default" size="icon-sm" disabled={!canSubmit} aria-label="发送" title="发送">
                <ArrowUp />
              </InputGroupButton>
            </div>
          </InputGroupAddon>
        )}
      </InputGroup>
    </form>
  );
}
