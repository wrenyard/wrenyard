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
  const canSubmit = !disabled && !submitDisabled && (value.trim() !== '' || hasAttachments);

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
      <InputGroup className={compact ? (leading === undefined ? 'rounded-2xl pl-1' : 'rounded-2xl') : undefined}>
        {compact && leading !== undefined && (
          <InputGroupAddon align="inline-start" className="h-8 self-end py-0">
            {leading}
          </InputGroupAddon>
        )}
        {!compact && attachments !== undefined && attachments !== null && (
          <div className="w-full px-2.5 pt-2">{attachments}</div>
        )}
        {/* The compact card viewport stays below the `md` breakpoint, so the
            textarea keeps the primitive's `text-base` 16px for typed text. The
            placeholder is 1px smaller and uses an arbitrary size (no line-height
            override) so it keeps `leading-8` and stays aligned with typed text. */}
        <InputGroupTextarea
          ref={textareaRef}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className={compact ? 'min-h-8 min-w-0 max-h-[min(10rem,35dvh)] overflow-y-auto py-0 leading-8 placeholder:text-[15px]' : 'max-h-60'}
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
          <InputGroupAddon align="inline-end" className="h-8 self-end gap-1 py-0">
            {toolbar}
            {toolbarTrailing}
            <InputGroupButton type="submit" variant="default" size="icon-xs" disabled={!canSubmit} aria-label="发送" title="发送">
              <ArrowUp />
            </InputGroupButton>
          </InputGroupAddon>
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
