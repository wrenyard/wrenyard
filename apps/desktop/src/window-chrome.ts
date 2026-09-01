export interface WindowChromeOptions {
  titleBarStyle?: 'hidden';
  titleBarOverlay?: {
    color: string;
    symbolColor: string;
    height: number;
  };
}

/** Keep native chrome by default; Windows uses themed native controls over a draggable app bar. */
export function platformWindowChrome(platform: NodeJS.Platform): WindowChromeOptions {
  if (platform !== 'win32') return {};
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#eee3ca',
      symbolColor: '#34291f',
      height: 32,
    },
  };
}
