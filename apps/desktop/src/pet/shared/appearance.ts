// ── Pet shared appearance adapter ────────────────────────────────────
// One renderer-safe adapter over the shell appearance channels. Pet overlay
// and panel preloads expose a narrow `window.petAppearance` bridge
// (getSnapshot + onChanged); this module caches the resolved value, mirrors it
// onto <html> for the shared Tailwind/theme styles, and offers a synchronous
// bridge for the React roots.
//
// It compiles under both the browser (DOM) and the main-process (no DOM) type
// libraries, so it never names `window`/`document` directly and only reaches
// them through a structural view of `globalThis`.

export interface PetAppearanceSnapshot {
  theme: string;
  dark: boolean;
  reduceMotion: boolean;
}

/** Synchronous appearance source handed to the React roots. */
export interface PetAppearanceBridge {
  getSnapshot(): PetAppearanceSnapshot;
  subscribe(listener: (next: PetAppearanceSnapshot) => void): () => void;
}

/** Narrow preload API exposed on `window.petAppearance`. */
export interface PetAppearanceApi {
  getSnapshot(): Promise<PetAppearanceSnapshot>;
  onChanged(listener: (next: PetAppearanceSnapshot) => void): () => void;
  /** Open an http(s) link out of process; other schemes are rejected by the shell handler. */
  openExternal(url: string): Promise<void>;
}

interface AppearanceDocumentElement {
  dataset: Record<string, string>;
  classList: { toggle(token: string, force: boolean): void };
}

interface AppearanceHost {
  document?: { documentElement?: AppearanceDocumentElement };
  petAppearance?: PetAppearanceApi;
}

export const DEFAULT_PET_APPEARANCE: PetAppearanceSnapshot = {
  theme: 'paper',
  dark: false,
  reduceMotion: false,
};

function appearanceHost(): AppearanceHost {
  return globalThis as unknown as AppearanceHost;
}

function normalizeAppearance(value: unknown): PetAppearanceSnapshot {
  if (typeof value !== 'object' || value === null) return DEFAULT_PET_APPEARANCE;
  const record = value as Record<string, unknown>;
  return {
    theme: typeof record.theme === 'string' ? record.theme : DEFAULT_PET_APPEARANCE.theme,
    dark: record.dark === true,
    reduceMotion: record.reduceMotion === true,
  };
}

let current: PetAppearanceSnapshot = DEFAULT_PET_APPEARANCE;
const listeners = new Set<(next: PetAppearanceSnapshot) => void>();
let subscribedToPreload = false;

function applyAppearanceToRoot(appearance: PetAppearanceSnapshot): void {
  const element = appearanceHost().document?.documentElement;
  if (!element) return;
  element.dataset.theme = appearance.theme;
  element.dataset.motion = appearance.reduceMotion ? 'reduce' : 'system';
  element.classList.toggle('dark', appearance.dark);
}

function publish(appearance: PetAppearanceSnapshot): void {
  current = appearance;
  applyAppearanceToRoot(appearance);
  for (const listener of listeners) listener(appearance);
}

/** Synchronous bridge for OverlayRoot / panel React roots. */
export const petAppearanceBridge: PetAppearanceBridge = {
  getSnapshot: () => current,
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/**
 * Resolve the initial appearance and follow live changes from the narrow
 * preload bridge. Called once before a React root paints. A missing bridge
 * (static preview / non-Pet host) keeps the default appearance.
 */
export async function initializePetAppearance(): Promise<void> {
  const api = appearanceHost().petAppearance;
  if (!api) return;
  if (!subscribedToPreload) {
    subscribedToPreload = true;
    api.onChanged((next) => publish(normalizeAppearance(next)));
  }
  try {
    publish(normalizeAppearance(await api.getSnapshot()));
  } catch {
    // Keep the default appearance when the snapshot round-trip fails.
  }
}
