import { useRef, type ReactNode, type RefObject } from 'react';
import { ArrowUp } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { Textarea } from '@/renderer/components/ui/textarea';
import { cn } from '@/renderer/lib/utils';

export interface PromptInputProps {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  submitDisabled?: boolean;
  toolbar?: ReactNode;
  hint?: ReactNode;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  className?: string;
}

/**
 * Auto-growing composed input. `Enter` submits, `Shift+Enter` inserts a
 * newline, and an active IME composition never submits. The send control is
 * always a send button; interrupting a turn happens on that turn's message.
 */
export function PromptInput({
  value,
  onValueChange,
  onSubmit,
  placeholder,
  disabled = false,
  submitDisabled = false,
  toolbar,
  hint,
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
      className={cn('rounded-xl border border-border bg-card p-2 shadow-sm', className)}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Textarea
        ref={textareaRef}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className="field-sizing-content max-h-60 min-h-9 resize-none border-0 bg-transparent px-1.5 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
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
      <div className="mt-1 flex items-end justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">{toolbar}</div>
        <div className="flex items-center gap-2">
          {hint}
          <Button type="submit" size="icon-sm" disabled={!canSubmit} aria-label="发送" title="发送">
            <ArrowUp />
          </Button>
        </div>
      </div>
    </form>
  );
}
