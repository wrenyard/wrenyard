import type { MouseEvent, ReactElement } from 'react';
import { useRef } from 'react';
import { Copy, Reply } from 'lucide-react';
import { copyText } from '@/renderer/lib/desktop';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/renderer/components/ui/context-menu';

/** Right-click menu of one message bubble; copies the message or the selection, and replies when enabled. */
export function ReplyMenu({
  text,
  onReply,
  children,
}: {
  text: string;
  onReply?: (() => void) | undefined;
  children: ReactElement;
}) {
  const selectionRef = useRef<string | null>(null);

  function handleContextMenuCapture(event: MouseEvent<HTMLElement>) {
    const selection = window.getSelection();
    if (
      selection !== null &&
      !selection.isCollapsed &&
      selection.anchorNode !== null &&
      selection.focusNode !== null &&
      event.currentTarget.contains(selection.anchorNode) &&
      event.currentTarget.contains(selection.focusNode)
    ) {
      selectionRef.current = selection.toString();
    } else {
      selectionRef.current = text;
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} className="select-text" onContextMenuCapture={handleContextMenuCapture} />
      <ContextMenuContent>
        <ContextMenuItem onClick={() => void copyText(selectionRef.current ?? text)}>
          <Copy />
          复制
        </ContextMenuItem>
        {onReply !== undefined && (
          <ContextMenuItem onClick={onReply}>
            <Reply />
            回复
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
