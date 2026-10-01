export const THEMES = [
  { id: 'paper', label: '纸本' },
  { id: 'neutral', label: '简约' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

const THEME_STORAGE_KEY = 'wrenyard:theme';

export function readTheme(): ThemeId {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return THEMES.some((theme) => theme.id === stored) ? (stored as ThemeId) : 'paper';
}

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}
