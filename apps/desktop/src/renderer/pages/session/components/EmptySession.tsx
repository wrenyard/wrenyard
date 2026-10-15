import { useState, type ReactNode } from 'react';
import { useMiniMode } from '@/renderer/lib/mini';
import { useThemeIcon } from '@/renderer/lib/theme';
import { EmptyActivity } from './EmptyActivity.js';
import { EmptyStats } from './EmptyStats.js';

/** Time-of-day greeting for the local clock, chosen once when the page mounts. */
function greetingForNow(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour <= 10) return '早上好';
  if (hour >= 11 && hour <= 12) return '中午好';
  if (hour >= 13 && hour <= 17) return '下午好';
  if (hour >= 18 && hour <= 22) return '晚上好';
  return '夜深了';
}

/** Welcome shown for the draft state and for sessions without turns. */
export function EmptySession({ children }: { children?: ReactNode }) {
  const themeIcon = useThemeIcon();
  const mini = useMiniMode();
  const [greeting] = useState(greetingForNow);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={mini
          ? 'flex w-full flex-col items-start gap-4 px-4 pt-4 text-left'
          : 'mx-auto flex w-full max-w-3xl flex-col items-start gap-6 px-4 pt-12 text-left'}
      >
        <div className="flex flex-col items-start gap-2">
          <img className="size-6 rounded" src={themeIcon} alt="" aria-hidden="true" />
          <h1 className={mini ? 'text-lg font-semibold' : 'text-2xl font-semibold tracking-tight'}>
            {`${greeting}，有什么要一起做的？`}
          </h1>
          {!mini && (
            <p className="text-sm/relaxed text-muted-foreground">可以随时发送多条消息，并行推进多个轮次。</p>
          )}
        </div>
        <EmptyStats compact={mini} />
        {mini ? <EmptyActivity weeks={12} /> : <EmptyActivity />}
      </div>
      <div className="flex-1" />
      {/* A draft card renders its composer here, not through the page's mini
          wrapper, so the mini edge gap (16px sides, 20px bottom) has to sit on
          this element. The shell keeps the literal classes unchanged. */}
      {children && (
        <div className={mini ? 'w-full px-4 pt-2 pb-5' : 'mx-auto w-full max-w-3xl px-4 pb-4'}>{children}</div>
      )}
    </div>
  );
}
