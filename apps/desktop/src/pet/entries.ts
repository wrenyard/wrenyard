/**
 * Pet pages and preloads, relative to `src/`.
 *
 * This is the Pet module's compile-time manifest. The Desktop entry list
 * (`src/entries.ts`) expands it so electron.vite.config.ts and the main
 * process share one source of entry paths without importing Pet runtime code.
 */
export const PET_PAGES = {
  house: 'pet/overlay/house/index.html',
  worker: 'pet/overlay/worker/index.html',
  entity: 'pet/overlay/entity/index.html',
  // Graph Slip and the task transcript share one React entry, selected with
  // `?panel=slip|transcript`, so both panels reuse the shell's UI components.
  'graph-slip': 'pet/panels/index.html',
  transcript: 'pet/panels/index.html',
} as const;

export const PET_PRELOADS = {
  pet: 'pet/main/preload/index.ts',
  entity: 'pet/main/preload/entity.ts',
  'graph-slip': 'pet/main/preload/graph-slip.ts',
  transcript: 'pet/main/preload/transcript.ts',
} as const;
