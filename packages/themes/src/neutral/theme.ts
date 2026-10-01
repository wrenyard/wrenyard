import type { ThemeDefinition } from '../types.ts';

export const neutralTheme = {
  id: 'neutral',
  label: '简约',
  description: 'shadcn neutral 中性外观',
  modes: {
    light: {
      windowBackground: '#ffffff',
      titleBarOverlay: { color: '#ffffff', symbolColor: '#0a0a0a' },
      codeTheme: 'github-light',
    },
    dark: {
      windowBackground: '#0a0a0a',
      titleBarOverlay: { color: '#0a0a0a', symbolColor: '#fafafa' },
      codeTheme: 'github-dark-default',
    },
  },
  icon: {
    png1024: 'src/neutral/assets/icon-1024.png',
    png256: 'src/neutral/assets/icon-256.png',
  },
} as const satisfies ThemeDefinition;

/** Vite bundles the icon for renderer consumers; native consumers use the relative icon paths. */
export const neutralIconUrl = new URL('./assets/icon-256.png', import.meta.url).href;
