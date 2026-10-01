import type { ThemeDefinition } from '../types.ts';

export const neutralTheme = {
  id: 'neutral',
  label: '简约',
  description: 'shadcn neutral 中性外观',
  modes: {
    light: {
      windowBackground: 'oklch(1 0 0)',
      titleBarOverlay: { color: 'oklch(1 0 0)', symbolColor: 'oklch(0.145 0 0)' },
      codeTheme: 'github-light',
    },
    dark: {
      windowBackground: 'oklch(0.145 0 0)',
      titleBarOverlay: { color: 'oklch(0.145 0 0)', symbolColor: 'oklch(0.985 0 0)' },
      codeTheme: 'github-dark-default',
    },
  },
  icon: {
    png1024: 'src/neutral/assets/icon-1024.png',
    png256: 'src/neutral/assets/icon-256.png',
  },
} as const satisfies ThemeDefinition;
