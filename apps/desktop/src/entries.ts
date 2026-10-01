/** Renderer pages, relative to `src/`; shared by electron.vite.config.ts and the main process. */
import { PET_PAGES, PET_PRELOADS } from './pet/entries.js';

export const DESKTOP_PAGES = {
  shell: 'renderer/index.html',
  ...PET_PAGES,
} as const;
export type DesktopPage = keyof typeof DESKTOP_PAGES;

/** Preload entries, relative to `src/`; each builds to `dist/preload/<id>.cjs`. */
export const DESKTOP_PRELOADS = {
  shell: 'preload.ts',
  ...PET_PRELOADS,
} as const;
export type DesktopPreload = keyof typeof DESKTOP_PRELOADS;
