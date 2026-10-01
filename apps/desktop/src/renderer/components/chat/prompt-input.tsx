import { useRef, type ReactNode, type RefObject } from 'react';
import { ArrowUp } from 'lucide-react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/renderer/components/ui/input-group';

export interface PromptInputProps {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  submitDisabled?: boolean;
  toolbar?: ReactNode;
  /** Rendered at the trailing edge, just before the send button. */
  toolbarTrailing?: ReactNode;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  className?: string;
}

/**
 * Auto-growing composed input. `Enter` submits, `Shift+Enter` inserts a
 * newline, and an active IME composition never submits. The send control is
 * always a send button; interrupting a turn happens on that turn's message.
 * `submitDisabled` blocks Enter and the button while keeping the textarea
 * editable, so the user can fix the model or text that blocks sending.
 */
export function PromptInput({
  value,
  onValueChange,
  onSubmit,
  placeholder,
  disabled = false,
  submitDisabled = false,
  toolbar,
  toolbarTrailing,
  textareaRef,
  className,
}: PromptInputProps) {
  const composing = useRef(false);
  const canSubmit = !disabled && !submitDisabled && value.trim() !== '';

  const submit = (): void => {
    if (canSubmit) onSubmit();
  };

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <InputGroup>
        <InputGroupTextarea
          ref={textareaRef}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="max-h-60"
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
        />
        <InputGroupAddon align="block-end">
          <div className="flex min-w-0 items-center gap-1.5">{toolbar}</div>
          <div className="ml-auto flex items-center gap-1.5">
            {toolbarTrailing}
            <InputGroupButton type="submit" variant="default" size="icon-sm" disabled={!canSubmit} aria-label="发送" title="发送">
              <ArrowUp />
            </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
