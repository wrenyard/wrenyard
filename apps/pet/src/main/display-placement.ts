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

export function displayMenuLabel(display: DisplayLike, index: number): string {
  return `显示器 ${index + 1} (${display.bounds.width}×${display.bounds.height})`;
}

export function bottomDockedBounds(
  display: DisplayLike,
  windowHeight: number,
  bottomOffset = 0,
): DisplayRect {
  const { x, y, width, height } = display.workArea;
  return {
    x,
    y: y + height - windowHeight - bottomOffset,
    width,
    height: windowHeight,
  };
}
