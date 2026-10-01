import type { ThemeDefinition } from '../types.ts';

export const paperTheme = {
  id: 'paper',
  label: '纸本',
  description: '暖色纸本外观',
  modes: {
    light: {
      windowBackground: '#f7efd8',
      titleBarOverlay: { color: '#f7efd8', symbolColor: '#2e2018' },
      codeTheme: 'github-light',
    },
    dark: {
      windowBackground: '#1c1813',
      titleBarOverlay: { color: '#1c1813', symbolColor: '#ece3d0' },
      codeTheme: 'github-dark-default',
    },
  },
  icon: {
    png1024: 'src/paper/assets/icon-1024.png',
    png256: 'src/paper/assets/icon-256.png',
  },
} as const satisfies ThemeDefinition;
