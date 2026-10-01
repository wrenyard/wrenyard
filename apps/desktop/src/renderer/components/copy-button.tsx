import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';
import { copyText } from '@/renderer/lib/desktop';
import { cn } from 'cn';

export interface CopyButtonProps {
  text: string;
  className?: string;
  label?: string;
  size?: 'icon' | 'icon-sm';
}

/** Copies text through the desktop bridge, falling back to the clipboard API. */
export function CopyButton({ text, className, label = '复制', size = 'icon' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void copyText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };

  return (
    <Button type="button" variant="ghost" size={size} className={cn(className)} aria-label={label}
      title={label} onClick={copy}>
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
