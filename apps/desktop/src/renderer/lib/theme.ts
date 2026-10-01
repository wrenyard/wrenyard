import { useSyncExternalStore } from 'react';
import { BUILTIN_THEMES, DEFAULT_THEME_ID, THEME_ICON_URLS } from '@wrenyard/themes';
import type { AppearanceSettings, ColorMode, MotionPreference, ResolvedAppearance } from '@/shell-contract';
import { onAppearanceChanged, shell } from './desktop.js';

export type ThemeId = (typeof BUILTIN_THEMES)[number]['id'];
export type { AppearanceSettings, ColorMode, MotionPreference, ResolvedAppearance };

/** Theme registry projection for the settings UI; never a hardcoded list. */
export const THEMES = BUILTIN_THEMES.map((theme) => ({
  id: theme.id,
  label: theme.label,
  description: theme.description,
}));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && BUILTIN_THEMES.some((theme) => theme.id === value);
}

const DEFAULT_APPEARANCE: ResolvedAppearance = {
  theme: DEFAULT_THEME_ID,
  dark: false,
  reduceMotion: false,
};

function normalizeAppearance(value: ResolvedAppearance | undefined): ResolvedAppearance {
  if (!value || typeof value !== 'object') return DEFAULT_APPEARANCE;
  return {
    theme: isThemeId(value.theme) ? value.theme : DEFAULT_THEME_ID,
    dark: value.dark === true,
    reduceMotion: value.reduceMotion === true,
  };
}

/* ------------------------------------------------------------------ */
/* Theme icon URLs                                                     */
/* ------------------------------------------------------------------ */

const FALLBACK_THEME_ICON = THEME_ICON_URLS[DEFAULT_THEME_ID] ?? Object.values(THEME_ICON_URLS)[0] ?? '';

/** Bundled icon URL for a theme id, falling back to the default theme icon. */
export function themeIconUrl(theme: string): string {
  return THEME_ICON_URLS[theme] ?? FALLBACK_THEME_ICON;
}

/* ------------------------------------------------------------------ */
/* Appearance store                                                    */
/* ------------------------------------------------------------------ */

let current: ResolvedAppearance = normalizeAppearance(shell?.initialAppearance);
const appearanceListeners = new Set<() => void>();

function applyToDocument(appearance: ResolvedAppearance, animate: boolean): void {
  const root = document.documentElement;
  if (animate) {
    // Suppress transitions for one frame so every element changes color in
    // lockstep instead of drifting at its own speed.
    root.dataset.themeSwitching = 'true';
    requestAnimationFrame(() => {
      delete root.dataset.themeSwitching;
    });
  }
  root.dataset.theme = appearance.theme;
  root.classList.toggle('dark', appearance.dark);
  root.dataset.motion = appearance.reduceMotion ? 'reduce' : 'system';
}

function publish(next: ResolvedAppearance): void {
  if (next.theme === current.theme && next.dark === current.dark && next.reduceMotion === current.reduceMotion) {
    return;
  }
  current = next;
  applyToDocument(next, true);
  for (const listener of appearanceListeners) listener();
}

// Subscribe at module load so a change pushed before React mounts is not lost.
onAppearanceChanged((next) => publish(normalizeAppearance(next)));

function subscribeAppearance(listener: () => void): () => void {
  appearanceListeners.add(listener);
  return () => {
    appearanceListeners.delete(listener);
  };
}

function getAppearance(): ResolvedAppearance {
  return current;
}

/** Resolved appearance, kept in sync by the bridge `appearance-changed` push. */
export function useAppearance(): ResolvedAppearance {
  return useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
}

/** Current theme's application icon, for in-app surfaces. */
export function useThemeIcon(): string {
  return themeIconUrl(useAppearance().theme);
}

/**
 * Apply the boot appearance before React mounts. Called first from
 * `theme-boot.ts` so the first paint already carries `data-theme`, `dark` and
 * `data-motion`.
 */
export function bootAppearance(): void {
  applyToDocument(current, false);
}

/* ------------------------------------------------------------------ */
/* Legacy localStorage migration                                       */
/* ------------------------------------------------------------------ */

const LEGACY_THEME_KEY = 'wrenyard:theme';

/**
 * Migrate the pre-main-process theme choice once. The stored value is saved
 * through the main process; the legacy key is removed only after that save
 * succeeds, so a failed save retries on the next start.
 */
export async function migrateLegacyTheme(): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  const legacy = localStorage.getItem(LEGACY_THEME_KEY);
  if (legacy === null) return;
  if (!isThemeId(legacy)) {
    localStorage.removeItem(LEGACY_THEME_KEY);
    return;
  }
  try {
    await shell.setAppearance({ theme: legacy });
    localStorage.removeItem(LEGACY_THEME_KEY);
  } catch {
    // Keep the key so the migration is retried on the next start.
  }
}
