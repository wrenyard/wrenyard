import type { ReactNode } from 'react';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/renderer/components/ui/empty';

/** Welcome shown for the draft state and for sessions without turns. */
export function EmptySession({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 p-6">
      <Empty className="border-0">
        <EmptyHeader>
          <EmptyTitle className="text-lg">有什么要一起做的？</EmptyTitle>
          <EmptyDescription>可以随时发送多条消息，并行推进多个轮次。</EmptyDescription>
        </EmptyHeader>
      </Empty>
      {children && <div className="w-full max-w-3xl">{children}</div>}
    </div>
  );
}
