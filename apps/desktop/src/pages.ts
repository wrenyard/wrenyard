import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow } from 'electron';
import { DESKTOP_PAGES, type DesktopPage, type DesktopPreload } from './entries.js';

export interface PageLoader {
  /** Loads a page with an optional query; resolves like loadURL/loadFile. */
  load(win: BrowserWindow, page: DesktopPage, query?: Record<string, string>): Promise<void>;
  /** Exact page URL without query or hash, for navigation guards. */
  url(page: DesktopPage): string;
}

export interface PageLoaderOptions {
  appPath: string;
  packaged: boolean;
  env: NodeJS.ProcessEnv;
}

/** `electron-vite dev` publishes its renderer server as ELECTRON_RENDERER_URL; a packaged app never uses it. */
function devServerBase(options: PageLoaderOptions): string | undefined {
  const configured = options.env.ELECTRON_RENDERER_URL?.trim();
  if (options.packaged || !configured) return undefined;
  try {
    const url = new URL(configured);
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      url.search = '';
      url.hash = '';
      return url.href.replace(/\/$/, '');
    }
  } catch { /* Fall through to the warning below. */ }
  console.warn('[wrenyard-desktop] Ignoring non-loopback ELECTRON_RENDERER_URL');
  return undefined;
}

export function createPageLoader(options: PageLoaderOptions): PageLoader {
  const base = devServerBase(options);
  const file = (page: DesktopPage): string => join(options.appPath, 'dist', 'web', DESKTOP_PAGES[page]);
  return {
    url: page => base ? `${base}/${DESKTOP_PAGES[page]}` : pathToFileURL(file(page)).href,
    load(win, page, query) {
      if (!base) return win.loadFile(file(page), { query });
      const url = new URL(`${base}/${DESKTOP_PAGES[page]}`);
      if (query) url.search = new URLSearchParams(query).toString();
      return win.loadURL(url.href);
    },
  };
}

export function preloadPath(appPath: string, id: DesktopPreload): string {
  return join(appPath, 'dist', 'preload', `${id}.cjs`);
}
