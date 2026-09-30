import type { ReactNode } from 'react';
import { cn } from '@/renderer/lib/utils';

export interface ShimmerTextProps {
  children: ReactNode;
  className?: string;
}

/**
 * Text with the base-nova `shimmer` utility. No motion dependency: the glow is
 * a CSS background animation, disabled under `prefers-reduced-motion`.
 */
export function ShimmerText({ children, className }: ShimmerTextProps) {
  return <span className={cn('shimmer', className)}>{children}</span>;
}
