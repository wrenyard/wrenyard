/** Renderer pages, relative to `src/`; shared by electron.vite.config.ts and the main process. */
export const DESKTOP_PAGES = {
  shell: 'renderer/index.html',
  house: 'pet/overlay/house/index.html',
  worker: 'pet/overlay/worker/index.html',
  entity: 'pet/overlay/taskgraph-entity/index.html',
  'graph-slip': 'pet/panels/observatory/index.html',
  transcript: 'pet/panels/transcript/index.html',
} as const;
export type DesktopPage = keyof typeof DESKTOP_PAGES;

/** Preload entries, relative to `src/`; each builds to `dist/preload/<id>.cjs`. */
export const DESKTOP_PRELOADS = {
  shell: 'preload.ts',
  pet: 'pet/main/preload.ts',
  entity: 'pet/preloads/entity-preload.ts',
  'graph-slip': 'pet/preloads/graph-slip-preload.ts',
  transcript: 'pet/preloads/transcript-preload.ts',
} as const;
export type DesktopPreload = keyof typeof DESKTOP_PRELOADS;
