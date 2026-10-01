/**
 * Theme package contract. This module is pure data and types: it must not
 * import React, Electron or anything from the Desktop app so the main process,
 * the renderer and future surfaces can all consume it directly.
 */

export type ThemeMode = 'light' | 'dark';

/**
 * Per-mode metadata consumed outside CSS: the main process uses it for the
 * BrowserWindow background, the Windows title bar buttons and the code
 * highlighting theme.
 */
export interface ThemeModeDefinition {
  /** BrowserWindow.backgroundColor; equals the theme's `--background`. */
  windowBackground: string;
  /** Windows title bar button colors. */
  titleBarOverlay: { color: string; symbolColor: string };
  /** Shiki theme name used by code highlighting. */
  codeTheme: string;
}

export interface ThemeDefinition {
  /** Matches the `data-theme` value on `<html>`. */
  id: string;
  label: string;
  description?: string;
  modes: Record<ThemeMode, ThemeModeDefinition>;
  /** Icon paths relative to the package root. */
  icon: { png1024: string; png256: string };
}

/**
 * The complete CSS custom-property set every theme must define, in both light
 * and dark modes. See the desktop theme switch spec §1 plus the `--overlay`
 * token added by the interaction foundations spec §1.4. The dark-mode token
 * implementation is tracked separately.
 */
export const REQUIRED_TOKENS = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--border',
  '--input',
  '--ring',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--radius',
  '--sidebar',
  '--sidebar-foreground',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-accent',
  '--sidebar-accent-foreground',
  '--sidebar-border',
  '--sidebar-ring',
  '--success',
  '--success-foreground',
  '--warning',
  '--warning-foreground',
  '--scrollbar-thumb',
  '--scrollbar-track',
  '--app-font-sans',
  '--app-font-mono',
  '--overlay',
] as const;

export type RequiredToken = (typeof REQUIRED_TOKENS)[number];
