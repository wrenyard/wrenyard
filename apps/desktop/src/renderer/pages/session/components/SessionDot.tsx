/**
 * Fixed-width leading slot for a session row. It always renders the slot so
 * titles align whether or not the session is running; when running it shows an
 * 8px currentColor ring that pulses between hollow and filled.
 */
export function SessionDot({ running }: { running?: boolean }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {running ? (
        <span
          role="status"
          aria-label="运行中"
          className="size-2 rounded-full border-[1.5px] border-current text-primary motion-session-dot"
        />
      ) : null}
    </span>
  );
}
