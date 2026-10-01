import { BUILTIN_THEMES, DEFAULT_THEME_ID } from '@wrenyard/themes';

export const THEMES = BUILTIN_THEMES.map((theme) => ({ id: theme.id, label: theme.label }));

export type ThemeId = (typeof BUILTIN_THEMES)[number]['id'];

const THEME_STORAGE_KEY = 'wrenyard:theme';

function isThemeId(value: string | null): value is ThemeId {
  return value !== null && BUILTIN_THEMES.some((theme) => theme.id === value);
}

export function readTheme(): ThemeId {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return isThemeId(stored) ? stored : DEFAULT_THEME_ID;
}

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}
