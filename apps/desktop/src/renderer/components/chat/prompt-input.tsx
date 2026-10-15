import {
  useRef,
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
}: PromptInputProps) {
  const composing = useRef(false);
  const canSubmit = !disabled && !submitDisabled && (value.trim() !== '' || hasAttachments);
  const hasLeading = toolbarLeading !== undefined && toolbarLeading !== null;

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
      {/* One layout at every window size: the textarea and the trailing controls
          share a row while there is room, and the controls wrap to the next
          (right-aligned) row once the textarea's ~12rem basis no longer fits, so
          narrow cards (down to the 300px mini minimum) never clip the controls. */}
      <InputGroup className="flex flex-wrap items-end gap-x-1 gap-y-1 sm:gap-x-1.5 h-auto">
        {attachments !== undefined && attachments !== null && (
          <div className="w-full min-w-0 px-2.5 pt-2">{attachments}</div>
        )}
        {hasLeading && (
          <div className="flex min-w-0 items-center gap-1 pl-1 sm:gap-1.5 sm:pl-1.5">{toolbarLeading}</div>
        )}
        {/* The textarea keeps the primitive's `field-sizing-content`, so it grows
            with the text and scrolls once it reaches `max-h-60`. */}
        <InputGroupTextarea
          ref={textareaRef}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="min-h-10 min-w-0 basis-48 grow leading-6 max-h-60"
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
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1 pr-1 sm:gap-1.5 sm:pr-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1 sm:gap-1.5">{toolbar}</div>
          {toolbarTrailing}
          <InputGroupButton type="submit" variant="default" size="icon-sm" className="shrink-0" disabled={!canSubmit} aria-label="发送" title="发送">
            <ArrowUp />
          </InputGroupButton>
        </div>
      </InputGroup>
    </form>
  );
}
