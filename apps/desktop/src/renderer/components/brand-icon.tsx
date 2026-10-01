import type { ComponentProps } from 'react';
import { cn } from 'cn';
import { brandIconSrc } from '@/renderer/lib/brand-icons';

export interface BrandIconProps extends Omit<ComponentProps<'img'>, 'src'> {
  /** Brand key resolved by `providerBrand` or `familyBrand`. */
  brand: string;
  /** Rendered square size in pixels. */
  size?: number;
}

/**
 * Decorative brand mark reusing the existing SVG brand artwork. Purely
 * presentational: it carries no product, window or page logic.
 */
export function BrandIcon({
  brand,
  size = 20,
  className,
  alt = '',
  ...props
}: BrandIconProps) {
  const src = brandIconSrc(brand);
  if (src === null) return null;
  return (
    <img
      src={src}
      alt={alt}
      aria-hidden="true"
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      {...props}
    />
  );
}
