/** Windows title bar button strip height; the theme only owns the colors. */
const TITLE_BAR_HEIGHT = 32;

export interface WindowChromeOptions {
  titleBarStyle?: 'hidden';
  titleBarOverlay?: {
    color: string;
    symbolColor: string;
    height: number;
  };
}

/**
 * Keep native chrome by default; Windows uses themed native controls over a
 * draggable app bar. The overlay colors come from the resolved theme mode, so
 * Desktop keeps no color table of its own.
 */
export function platformWindowChrome(
  platform: NodeJS.Platform,
  overlay?: { color: string; symbolColor: string },
): WindowChromeOptions {
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
