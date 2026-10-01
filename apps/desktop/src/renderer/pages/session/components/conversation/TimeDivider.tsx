import { Marker, MarkerContent } from '@/renderer/components/ui/marker';

export interface TimeDividerProps {
  /** Formatted divider label. */
  label: string;
}

/** Centred calendar divider shown between chat messages that are far apart. */
export function TimeDivider({ label }: TimeDividerProps) {
  return (
    <Marker variant="separator">
      <MarkerContent>{label}</MarkerContent>
    </Marker>
  );
}
