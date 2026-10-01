/**
 * Theme registry. Pure data and lookups only — no React, Electron or Desktop
 * imports — so every surface can read the same definitions.
 */
import { neutralTheme } from './neutral/theme.ts';
import { paperTheme } from './paper/theme.ts';
import type { ThemeDefinition } from './types.ts';

export type { RequiredToken, ThemeDefinition, ThemeMode, ThemeModeDefinition } from './types.ts';
export { REQUIRED_TOKENS } from './types.ts';

export const DEFAULT_THEME_ID = 'paper' as const;

export const BUILTIN_THEMES = [paperTheme, neutralTheme] as const;

export type ThemeId = (typeof BUILTIN_THEMES)[number]['id'];

/** Returns the builtin theme for `id`, falling back to the default theme. */
export function getTheme(id: string): ThemeDefinition {
  return BUILTIN_THEMES.find((theme) => theme.id === id) ?? paperTheme;
}
