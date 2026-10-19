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
      foreground: 'oklch(0.145 0 0)',
      mutedForeground: 'oklch(0.556 0 0)',
      destructive: 'oklch(0.577 0.245 27.325)',
      destructiveForeground: '#ffffff',
    },
    dark: {
      windowBackground: '#0a0a0a',
      titleBarOverlay: { color: '#0a0a0a', symbolColor: '#fafafa' },
      codeTheme: 'github-dark-default',
      foreground: 'oklch(0.985 0 0)',
      mutedForeground: 'oklch(0.708 0 0)',
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
