/**
 * Title bar button strip height, shared by the Windows overlay and the
 * renderer's `--titlebar-height` token. It is exported once so the appearance
 * controller and the chrome options never drift apart.
 */
export const TITLE_BAR_HEIGHT = 48;

/** macOS traffic-light offset that vertically centers the 12px buttons. */
const MAC_TRAFFIC_LIGHT_POSITION = { x: 16, y: 17 } as const;

export interface WindowChromeOptions {
  titleBarStyle?: 'hidden' | 'hiddenInset';
  trafficLightPosition?: { x: number; y: number };
  titleBarOverlay?: {
    color: string;
    symbolColor: string;
    height: number;
  };
}

/**
 * The single platform chrome outlet. macOS hides the native title bar and
 * keeps the traffic lights inset; Windows keeps themed native controls over a
 * draggable app bar (the overlay colors come from the resolved theme mode, so
 * Desktop keeps no color table of its own); every other platform keeps the
 * native frame untouched.
 */
export function platformWindowChrome(
  platform: NodeJS.Platform,
  overlay?: { color: string; symbolColor: string },
): WindowChromeOptions {
  if (platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { ...MAC_TRAFFIC_LIGHT_POSITION } };
  }
  if (platform !== 'win32' || !overlay) return {};
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: overlay.color,
      symbolColor: overlay.symbolColor,
      height: TITLE_BAR_HEIGHT,
    },
  };
}
