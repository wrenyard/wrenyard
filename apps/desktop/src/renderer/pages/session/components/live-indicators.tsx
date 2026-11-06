/**
 * The session transcript's one live glyph: three accent dots turning around
 * their centre on the working row while its turn works. They stand still
 * under reduced motion. Styled in `globals.css`.
 */
import { cn } from 'cn';

/** Three accent dots turning around their centre while the turn works. */
export function WorkingDots({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('wy-dots relative inline-block size-3.5 shrink-0 text-primary', className)}>
      <span className="absolute left-1/2 top-0 size-1 -translate-x-1/2 rounded-full bg-current" />
      <span className="absolute bottom-0.5 left-0 size-1 rounded-full bg-current" />
      <span className="absolute bottom-0.5 right-0 size-1 rounded-full bg-current" />
    </span>
  );
}
