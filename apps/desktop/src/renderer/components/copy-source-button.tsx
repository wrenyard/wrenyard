import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/renderer/components/ui/button';

/** How long the copy confirmation stays visible. */
const FEEDBACK_MS = 1500;

/**
 * "Copy diagram source" affordance shared by the Mermaid surfaces. It copies
 * through the browser clipboard and is deliberately free of Mermaid, DOMPurify
 * and the desktop shell bridge, so both the lazily loaded diagram module and the
 * streaming placeholder can import it without pulling in heavy or
 * side-effectful modules and without a runtime import cycle.
 */
export function CopySourceButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(() => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        // Restart the confirmation window on every copy, never stacking timers.
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), FEEDBACK_MS);
      },
      () => undefined,
    );
  }, [code]);

  return (
    <Button type="button" variant="ghost" size="icon-sm" aria-label="复制源码" title="复制源码" onClick={copy}>
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
