export interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayLike {
  id: number;
  bounds: DisplayRect;
  workArea: DisplayRect;
}

export function resolveDisplay(
  displays: readonly DisplayLike[],
  primaryDisplay: DisplayLike,
  preferredDisplayId?: number,
): DisplayLike {
  if (preferredDisplayId !== undefined) {
    const preferred = displays.find((display) => display.id === preferredDisplayId);
    if (preferred) return preferred;
  }

  const attachedPrimary = displays.find((display) => display.id === primaryDisplay.id);
  return attachedPrimary ?? displays[0] ?? primaryDisplay;
}
