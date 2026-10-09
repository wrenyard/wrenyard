import type { ReactElement } from 'react';
import { Reply } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/renderer/components/ui/context-menu';

/** Right-click menu of one message bubble; renders the bubble as-is without `onReply`. */
export function ReplyMenu({ onReply, children }: { onReply?: (() => void) | undefined; children: ReactElement }) {
  if (onReply === undefined) return children;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} className="select-text" />
      <ContextMenuContent>
        <ContextMenuItem onClick={onReply}>
          <Reply />
          回复
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
