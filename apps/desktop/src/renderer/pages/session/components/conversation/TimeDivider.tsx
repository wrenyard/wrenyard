export interface TimeDividerProps {
  /** Formatted divider label. */
  label: string;
}

/** Centred calendar divider shown between chat messages that are far apart. */
export function TimeDivider({ label }: TimeDividerProps) {
  return (
    <div className="flex justify-center">
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
