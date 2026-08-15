export interface BrowserViewport {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

export function readBrowserViewport(win: Pick<Window, 'innerWidth' | 'innerHeight' | 'devicePixelRatio'>): BrowserViewport {
  return {
    cssWidth: win.innerWidth,
    cssHeight: win.innerHeight,
    dpr: win.devicePixelRatio || 1,
  };
}
