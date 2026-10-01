import type { ReactNode } from 'react';
import { MessageCircleDashed } from 'lucide-react';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/renderer/components/ui/empty';

/** Welcome shown for the draft state and for sessions without turns. */
export function EmptySession({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageCircleDashed />
          </EmptyMedia>
          <EmptyTitle>有什么要一起做的？</EmptyTitle>
          <EmptyDescription>可以随时发送多条消息，并行推进多个轮次。</EmptyDescription>
        </EmptyHeader>
      </Empty>
      {children && <div className="mx-auto w-full max-w-3xl px-4 pb-4">{children}</div>}
    </div>
  );
}
