import type { ThemeDefinition } from '../types.ts';

export const neutralTheme = {
  id: 'neutral',
  label: '简约',
  description: 'shadcn neutral 中性外观',
  modes: {
    light: {
      windowBackground: '#eff1f6',
      titleBarOverlay: { color: '#eff1f6', symbolColor: '#191c22' },
      codeTheme: 'github-light',
      foreground: 'oklch(0.18 0.01 255)',
      mutedForeground: 'oklch(0.49 0.012 255)',
      destructive: 'oklch(0.577 0.245 27.325)',
      destructiveForeground: '#ffffff',
    },
    dark: {
      windowBackground: '#111318',
      titleBarOverlay: { color: '#111318', symbolColor: '#e8ecf4' },
      codeTheme: 'github-dark-default',
      foreground: 'oklch(0.955 0.005 255)',
      mutedForeground: 'oklch(0.72 0.012 255)',
      destructive: 'oklch(0.704 0.191 22.216)',
      destructiveForeground: '#0a0a0a',
    },
  },
  fontSans: '"Geist Variable", ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
  radius: '0.625rem',
  icon: {
    png1024: 'src/neutral/assets/icon-1024.png',
    png256: 'src/neutral/assets/icon-256.png',
  },
} as const satisfies ThemeDefinition;
